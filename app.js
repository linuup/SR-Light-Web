/**
 * SR-Light BLE Web Controller Application Logic
 * Implements Web Bluetooth, PWA integration, Auto Time-Sync, and dynamic UX.
 */

// --- BLE MANAGER CLASS ---
class BleManager {
  constructor() {
    this.device = null;
    this.server = null;
    this.service = null;
    this.characteristic = null;

    // Configurable UUIDs (loaded from localStorage or default JDY-23)
    this.serviceUuid = localStorage.getItem('SR-Light_service_uuid') || '0000ffe0-0000-1000-8000-00805f9b34fb';
    this.characteristicUuid = localStorage.getItem('SR-Light_char_uuid') || '0000ffe1-0000-1000-8000-00805f9b34fb';

    this.isConnected = false;
    this.rxBuffer = '';
    this._syncTimer = null;  // Periodic re-sync timer handle

    // Callbacks
    this.onStatusChangeCallback = null;
    this.onReceiveCallback = null;
    this.onLogCallback = null;
  }

  log(message, type = 'info') {
    if (this.onLogCallback) {
      this.onLogCallback(message, type);
    } else {
      console.log(`[BleManager] [${type}] ${message}`);
    }
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error('此浏览器不支持 Web Bluetooth API。请使用 Chrome, Edge 或 Opera，并确保处于 HTTPS 安全上下文中。');
    }

    this.log('正在请求蓝牙设备扫描...', 'info');

    // Clean and normalize UUID strings into valid 128-bit UUIDs
    let serviceUuid = this.serviceUuid.toLowerCase().trim().replace(/^0x/, '');
    if (serviceUuid.length === 4) {
      serviceUuid = `0000${serviceUuid}-0000-1000-8000-00805f9b34fb`;
    }
    let characteristicUuid = this.characteristicUuid.toLowerCase().trim().replace(/^0x/, '');
    if (characteristicUuid.length === 4) {
      characteristicUuid = `0000${characteristicUuid}-0000-1000-8000-00805f9b34fb`;
    }

    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'SR' },
          { namePrefix: 'JDY' },
          { name: 'SR_Light' },
          { name: 'SR-Light' },
          { services: [serviceUuid] }
        ],
        optionalServices: [serviceUuid, '0000ffe0-0000-1000-8000-00805f9b34fb']
      });

      this.log(`发现设备: ${this.device.name || '未命名设备'}，开始建立连接...`, 'info');

      this.device.addEventListener('gattserverdisconnected', () => {
        this.handleDisconnection();
      });

      this.server = await this.device.gatt.connect();
      this.log('GATT 服务端连接成功，正在获取服务...', 'info');

      this.service = await this.server.getPrimaryService(serviceUuid);
      this.log('主服务获取成功，正在获取 Characteristic...', 'info');

      this.characteristic = await this.service.getCharacteristic(characteristicUuid);
      this.log('读写 Characteristic 获取成功！连接已就绪。', 'info');

      this.isConnected = true;
      if (this.onStatusChangeCallback) {
        this.onStatusChangeCallback(true);
      }

      // Listen for notifications/incoming messages from MCU with line buffering
      try {
        this.characteristic.addEventListener('characteristicvaluechanged', (event) => {
          const value = event.target.value;
          const decoder = new TextDecoder('utf-8');
          const rawText = decoder.decode(value);

          this.rxBuffer += rawText;

          let pos;
          while ((pos = this.rxBuffer.search(/[\r\n]/)) !== -1) {
            const line = this.rxBuffer.substring(0, pos).trim();
            this.rxBuffer = this.rxBuffer.substring(pos + 1);
            if (line.length > 0) {
              this.log(`← 接收到设备数据: ${line}`, 'rx');
              if (this.onReceiveCallback) {
                this.onReceiveCallback(line);
              }
            }
          }
          if (this.rxBuffer.length > 512) {
            const line = this.rxBuffer.trim();
            this.rxBuffer = '';
            if (line.length > 0) {
              this.log(`← 接收到设备数据: ${line}`, 'rx');
            }
          }
        });
        await this.characteristic.startNotifications();
        this.log('已成功订阅特征值通知。', 'info');
      } catch (notifyErr) {
        this.log(`无法开启通知订阅: ${notifyErr.message || notifyErr}`, 'warn');
      }

      // Trigger automatic time synchronization on connect
      await this.syncSystemTime();

      // Query current device status (brightness, CCT, alarm, sunrise params)
      try {
        await this.send('FL+QUERY?');
      } catch (qErr) {
        console.log('Status query after connect error:', qErr);
      }

      // Start periodic re-sync every 30 minutes to compensate LSI clock drift
      this._syncTimer = setInterval(async () => {
        if (this.isConnected) {
          this.log('定时校时 (30 min)：正在自动同步时间...', 'info');
          await this.syncSystemTime();
        }
      }, 30 * 60 * 1000);

    } catch (error) {
      this.log(`连接失败: ${error.message || error}`, 'error');
      this.handleDisconnection();
      throw error;
    }
  }

  handleDisconnection() {
    this.isConnected = false;
    this.server = null;
    this.service = null;
    this.characteristic = null;
    this.device = null;
    // Clear periodic re-sync timer
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    this.log('设备已断开连接。', 'info');
    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback(false);
    }
  }

  async disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.log('手动断开连接中...', 'info');
      this.device.gatt.disconnect();
    } else {
      this.handleDisconnection();
    }
  }


  async send(payload) {
    const isString = typeof payload === 'string';
    const textToSend = isString ? payload : JSON.stringify(payload);
    this.log(`→ 发送数据: ${textToSend}`, 'tx');

    if (!this.isConnected || !this.characteristic) {
      this.log('(提示: 当前未连接蓝牙设备。请先点击"搜索并连接设备"成功建立连接后再试)', 'warn');
      return;
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(textToSend + '\r\n');
    let sentSuccess = false;
    let lastErr = null;

    // Stage 1: Standard writeValue (Chrome auto-negotiation)
    if (typeof this.characteristic.writeValue === 'function') {
      try {
        await this.characteristic.writeValue(data);
        sentSuccess = true;
      } catch (e) {
        lastErr = e;
      }
    }

    // Stage 2: Explicit writeValueWithResponse
    if (!sentSuccess && typeof this.characteristic.writeValueWithResponse === 'function') {
      try {
        await this.characteristic.writeValueWithResponse(data);
        sentSuccess = true;
      } catch (e) {
        lastErr = e;
      }
    }

    // Stage 3: Explicit writeValueWithoutResponse
    if (!sentSuccess && typeof this.characteristic.writeValueWithoutResponse === 'function') {
      try {
        await this.characteristic.writeValueWithoutResponse(data);
        sentSuccess = true;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!sentSuccess) {
      const errMsg = lastErr ? (lastErr.message || String(lastErr)) : '未知错误';
      // Silently ignore "GATT operation already in progress" — this is a harmless
      // race condition between startNotifications and the first write; the data is
      // actually transmitted and the device ACKs it correctly.
      if (errMsg.toLowerCase().includes('gatt operation already in progress')) {
        return;
      }
      this.log(`发送数据失败: ${errMsg}`, 'error');
      throw lastErr || new Error('所有 BLE 写入方法均失败');
    }
  }

  async syncSystemTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');

    const command = `FL+TIME:${year}-${month}-${day} ${hour}:${minute}:${second}`;
    this.log(`手动/自动校时：使用设备当前时间 [${year}-${month}-${day} ${hour}:${minute}:${second}]`, 'info');
    await this.send(command);

    // Query status immediately after time sync so MCU returns full JSON with RTC time
    try {
      await this.send('FL+QUERY?');
    } catch (e) {
      // Ignored
    }
  }

  updateUuids(serviceUuid, charUuid) {
    this.serviceUuid = serviceUuid;
    this.characteristicUuid = charUuid;
    localStorage.setItem('SR-Light_service_uuid', serviceUuid);
    localStorage.setItem('SR-Light_char_uuid', charUuid);
    this.log(`UUID 配置已更新: Service = ${serviceUuid}, Char = ${charUuid}`, 'info');
  }
}

// --- GLOBAL CONTROLLERS (DEFINED AT SCRIPT EXECUTION TIME) ---
window.toggleConsoleModal = function (show = true) {
  const modal = document.getElementById('console-modal');
  const modalBleConsole = document.getElementById('modal-ble-console');
  if (!modal) return;
  if (show) {
    modal.classList.add('active');
    if (modalBleConsole) {
      modalBleConsole.scrollTop = modalBleConsole.scrollHeight;
    }
  } else {
    modal.classList.remove('active');
  }
};

window.syncTimeNow = async function () {
  const btn = document.getElementById('sync-time-btn');
  if (btn) btn.disabled = true;
  try {
    if (window.bleManagerInstance) {
      await window.bleManagerInstance.syncSystemTime();
    }
  } catch (e) {
    console.error(e);
  } finally {
    if (btn) btn.disabled = false;
  }
};

// --- UI CONTROLLER & APP INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  const bleManager = new BleManager();
  window.bleManagerInstance = bleManager;
  let timeInterval = null;

  // DOM Elements
  const bleConnectBtn = document.getElementById('ble-connect-btn');
  const bleDisconnectBtn = document.getElementById('ble-disconnect-btn');
  const bleStatusBadge = document.getElementById('ble-status-badge');
  const bleStatusText = document.getElementById('ble-status-text');
  const btnConnContainer = document.getElementById('btn-conn-container');
  const btnDisconnContainer = document.getElementById('btn-disconn-container');

  const valTime = document.getElementById('val-time');
  const valAlarm = document.getElementById('val-alarm');
  const valProgressPercent = document.getElementById('val-progress-percent');
  const valProgressBar = document.getElementById('val-progress-bar');
  const valOutputCct = document.getElementById('val-output-cct');

  const alarmTimeInput = document.getElementById('alarm-time');
  const saveAlarmBtn = document.getElementById('save-alarm-btn');

  const durationInput = document.getElementById('sunrise-duration');
  const startCctInput = document.getElementById('sunrise-start-cct');
  const endCctInput = document.getElementById('sunrise-end-cct');
  const saveSunriseBtn = document.getElementById('save-sunrise-btn');

  const brightnessSlider = document.getElementById('brightness-slider');
  const valBrightnessSlider = document.getElementById('val-brightness-slider');
  const cctSlider = document.getElementById('cct-slider');
  const valCctSlider = document.getElementById('val-cct-slider');

  const bleConsole = document.getElementById('ble-console');
  const clearConsoleBtn = document.getElementById('clear-console-btn');
  const expandConsoleBtn = document.getElementById('expand-console-btn');
  const manualSendInput = document.getElementById('manual-send-input');
  const manualSendBtn = document.getElementById('manual-send-btn');

  // Console Modal Elements
  const consoleModal = document.getElementById('console-modal');
  const consoleCloseX = document.getElementById('console-close-x');
  const modalBleConsole = document.getElementById('modal-ble-console');
  const modalClearConsoleBtn = document.getElementById('modal-clear-console-btn');
  const modalManualSendInput = document.getElementById('modal-manual-send-input');
  const modalManualSendBtn = document.getElementById('modal-manual-send-btn');

  // Settings Modal Elements
  const settingsToggleBtn = document.getElementById('settings-toggle-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsCloseX = document.getElementById('settings-close-x');
  const uuidServiceInput = document.getElementById('uuid-service');
  const uuidCharInput = document.getElementById('uuid-characteristic');
  const uuidResetBtn = document.getElementById('uuid-reset-btn');
  const uuidSaveBtn = document.getElementById('uuid-save-btn');

  // --- LOCAL STORAGE CACHE LOAD ---
  function loadCachedSettings() {
    const alarm = localStorage.getItem('SR-Light_alarm') || '07:00';
    if (alarmTimeInput) alarmTimeInput.value = alarm;
    if (valAlarm) valAlarm.textContent = alarm;

    if (durationInput) durationInput.value = localStorage.getItem('SR-Light_duration') || '30';
    if (startCctInput) startCctInput.value = localStorage.getItem('SR-Light_start_cct') || '2700';
    if (endCctInput) endCctInput.value = localStorage.getItem('SR-Light_end_cct') || '6500';

    if (uuidServiceInput) uuidServiceInput.value = bleManager.serviceUuid;
    if (uuidCharInput) uuidCharInput.value = bleManager.characteristicUuid;

    // Initial display of sliders
    if (valBrightnessSlider && brightnessSlider) valBrightnessSlider.textContent = `${brightnessSlider.value}%`;
    if (valCctSlider && cctSlider) valCctSlider.textContent = getCctLabel(cctSlider.value);
    if (valOutputCct && brightnessSlider && cctSlider) valOutputCct.textContent = `${brightnessSlider.value}% 亮度 · ${getCctLabel(cctSlider.value)}`;
  }

  // --- DIGITAL CLOCK ---
  function startClock() {
    function updateClock() {
      const now = new Date();
      const hrs = String(now.getHours()).padStart(2, '0');
      const mins = String(now.getMinutes()).padStart(2, '0');
      const secs = String(now.getSeconds()).padStart(2, '0');
      valTime.textContent = `${hrs}:${mins}:${secs}`;
    }
    updateClock();
    timeInterval = setInterval(updateClock, 1000);
  }

  // --- PROTOCOL CONSOLE LOGGER ---
  function logToConsole(message, type = 'info') {
    const time = new Date().toTimeString().split(' ')[0];
    let color = '#a29bfe';
    let prefix = '[系统]';

    if (type === 'error') {
      color = '#ff1744';
      prefix = '[错误]';
    } else if (type === 'warn') {
      color = '#ff9100';
      prefix = '[警告]';
    } else if (type === 'tx') {
      color = '#00e5ff';
      prefix = '[发送]';
    } else if (type === 'rx') {
      color = '#00e676';
      prefix = '[接收]';
    }

    const logItem = document.createElement('div');
    logItem.style.color = color;
    logItem.style.marginBottom = '4px';
    logItem.textContent = `[${time}] ${prefix} ${message}`;

    // Clean up placeholder text if present
    if (bleConsole && bleConsole.textContent.includes('等待连接设备')) {
      bleConsole.innerHTML = '';
    }
    if (modalBleConsole && modalBleConsole.textContent.includes('等待连接设备')) {
      modalBleConsole.innerHTML = '';
    }

    if (bleConsole) {
      bleConsole.appendChild(logItem);
      bleConsole.scrollTop = bleConsole.scrollHeight;
    }

    if (modalBleConsole) {
      const modalLogItem = logItem.cloneNode(true);
      modalBleConsole.appendChild(modalLogItem);
      modalBleConsole.scrollTop = modalBleConsole.scrollHeight;
    }
  }

  // Register logger to BleManager
  bleManager.onLogCallback = logToConsole;

  // --- BLE RECEIVE HANDLER ---
  // Parses telemetry messages from the device
  bleManager.onReceiveCallback = (rawText) => {
    try {
      const cleanText = rawText.trim();
      // Handle non-JSON ACK response for time sync
      if (cleanText.includes('ACK: TIME SET TO')) {
        const timeMatch = cleanText.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
        if (timeMatch) {
          const rtcTimeEl = document.getElementById('val-rtc-time');
          const rtcStatusEl = document.getElementById('val-rtc-status');
          if (rtcTimeEl) rtcTimeEl.textContent = timeMatch[0];
          if (rtcStatusEl) {
            rtcStatusEl.textContent = '已同步';
            rtcStatusEl.style.color = '#00e5ff';
          }
        }
      }

      // Expecting JSON format from device.
      if (cleanText.startsWith('{') && cleanText.endsWith('}')) {
        const p = JSON.parse(cleanText);

        // ── Progress & sunrise running state ───────────────────────
        const progVal = p.sun_prog !== undefined ? p.sun_prog : p.progress;
        if (progVal !== undefined) {
          const prog = Math.min(100, Math.max(0, progVal));
          if (valProgressBar) valProgressBar.style.width = `${prog}%`;
          if (valProgressPercent) valProgressPercent.textContent = `${prog}%`;
        }

        // ── Brightness ─────────────────────────────────────────────
        if (p.brightness !== undefined) {
          const b = p.brightness;
          if (brightnessSlider && document.activeElement !== brightnessSlider) {
            brightnessSlider.value = b;
          }
          if (valBrightnessSlider) valBrightnessSlider.textContent = `${b}%`;
        }

        // ── CCT (0–100 % scale from MCU) ───────────────────────────
        // MCU sends cct as 0–100 %; sliders use 2700–6500 K range.
        // Map: 0% warm → 2700K, 100% cool → 6500K
        if (p.cct !== undefined) {
          const cctPct = p.cct;
          const cctK = Math.round(2700 + (cctPct / 100) * (6500 - 2700));
          if (cctSlider && document.activeElement !== cctSlider) {
            cctSlider.value = cctK;
          }
          if (valCctSlider) valCctSlider.textContent = getCctLabel(cctK);
          const bright = p.brightness !== undefined ? p.brightness : (brightnessSlider ? brightnessSlider.value : 80);
          if (valOutputCct) valOutputCct.textContent = `${bright}% 亮度 · ${getCctLabel(cctK)}`;
        }

        // ── Alarm time & enable ────────────────────────────────────
        let alarmStr = null;
        if (p.alarm !== undefined) {
          alarmStr = p.alarm;
        } else if (p.alarm_h !== undefined && p.alarm_m !== undefined) {
          const hh = String(p.alarm_h).padStart(2, '0');
          const mm = String(p.alarm_m).padStart(2, '0');
          alarmStr = `${hh}:${mm}`;
        }
        if (alarmStr) {
          const [h, m] = alarmStr.split(':').map(Number);
          if (!isNaN(h)) alarmHour = h;
          if (!isNaN(m)) alarmMinute = m;
          updatePickerDisplay();
          valAlarm.textContent = alarmStr;
        }

        // ── RTC Time from MCU ──────────────────────────────────────
        if (p.time) {
          const rtcTimeEl = document.getElementById('val-rtc-time');
          const rtcStatusEl = document.getElementById('val-rtc-status');
          if (rtcTimeEl) rtcTimeEl.textContent = p.time;
          if (rtcStatusEl) {
            rtcStatusEl.textContent = '实时运行中';
            rtcStatusEl.style.color = '#00e5ff';
          }
        }

        // ── Sunrise Preset Card Highlight ──────────────────────────
        if (p.sun_dur !== undefined) {
          let presetKey = 'natural';
          if (p.sun_dur === 20) presetKey = 'energizing';
          else if (p.sun_dur === 45) presetKey = 'gentle';
          else presetKey = 'natural';

          const presetCards = document.querySelectorAll('.sunrise-preset-card');
          presetCards.forEach(c => {
            if (c.dataset.preset === presetKey) {
              c.classList.add('active');
              c.style.borderColor = '#00e5ff';
              c.style.background = 'rgba(0,229,255,0.08)';
            } else {
              c.classList.remove('active');
              c.style.borderColor = 'rgba(255,255,255,0.1)';
              c.style.background = 'rgba(255,255,255,0.03)';
            }
          });
        }
      }
    } catch (e) {
      logToConsole(`解析设备返回的数据时出错: ${e.message}`, 'warn');
    }
  };

  // --- BLE STATUS CHANGE HANDLER ---
  const splash = document.getElementById('connect-splash');
  const mainApp = document.getElementById('main-app');
  const splashError = document.getElementById('splash-error');

  function showMainApp() {
    if (splash) splash.classList.add('hidden');
    if (mainApp) mainApp.classList.add('visible');
  }

  function showSplash() {
    if (splash) splash.classList.remove('hidden');
    if (mainApp) mainApp.classList.remove('visible');
  }

  bleManager.onStatusChangeCallback = (connected) => {
    if (connected) {
      showMainApp();
      bleStatusBadge.className = 'status-badge connected';
      bleStatusText.textContent = '已连接';
      btnConnContainer.classList.add('d-none');
      btnDisconnContainer.classList.remove('d-none');
    } else {
      showSplash();
      bleStatusBadge.className = 'status-badge disconnected';
      bleStatusText.textContent = '已断开';
      btnConnContainer.classList.remove('d-none');
      btnDisconnContainer.classList.add('d-none');

      valProgressPercent.textContent = '0%';
      valProgressBar.style.width = '0%';
      valOutputCct.textContent = '--% @ --K';

      const rtcTimeEl = document.getElementById('val-rtc-time');
      const rtcStatusEl = document.getElementById('val-rtc-status');
      if (rtcTimeEl) rtcTimeEl.textContent = 'YYYY-MM-DD --:--:--';
      if (rtcStatusEl) {
        rtcStatusEl.textContent = '已断开';
        rtcStatusEl.style.color = 'var(--text-muted)';
      }
    }
  };

  // --- BUTTON EVENT LISTENERS ---

  // Splash Connect Button (big fullscreen button)
  const splashConnectBtn = document.getElementById('splash-connect-btn');
  const doConnect = async (btn) => {
    if (btn) btn.disabled = true;
    if (splashError) { splashError.style.display = 'none'; splashError.textContent = ''; }
    try {
      await bleManager.connect();
    } catch (err) {
      if (splashError && err && !err.message?.includes('User cancelled')) {
        splashError.textContent = `连接失败: ${err.message || err}`;
        splashError.style.display = 'block';
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  if (splashConnectBtn) {
    splashConnectBtn.addEventListener('click', () => doConnect(splashConnectBtn));
  }

  // Connect BLE Button (inside main app panel, after disconnect)
  bleConnectBtn.addEventListener('click', async () => {
    bleConnectBtn.disabled = true;
    try {
      await bleManager.connect();
    } catch (err) {
      // Errors logged in class
    } finally {
      bleConnectBtn.disabled = false;
    }
  });

  // Disconnect BLE Button
  bleDisconnectBtn.addEventListener('click', async () => {
    await bleManager.disconnect();
  });

  // Sync Phone/Device Time Button
  const syncTimeBtn = document.getElementById('sync-time-btn');
  if (syncTimeBtn) {
    syncTimeBtn.addEventListener('click', async () => {
      syncTimeBtn.disabled = true;
      try {
        logToConsole('手动触发：读取当前手机/设备系统时间进行同步...', 'info');
        await bleManager.syncSystemTime();
      } catch (err) {
        // Error logged
      } finally {
        syncTimeBtn.disabled = false;
      }
    });
  }

  // --- CCT NATURAL LABEL HELPER ---
  function getCctLabel(cctK) {
    if (cctK <= 3300) return '暖黄光';
    if (cctK <= 4800) return '自然白光';
    return '冷白光';
  }

  // --- 24-HOUR TOUCH TIME PICKER ---
  let alarmHour = 7;
  let alarmMinute = 0;

  const valHourEl = document.getElementById('picker-val-hour');
  const valMinuteEl = document.getElementById('picker-val-minute');

  function updatePickerDisplay() {
    if (valHourEl) valHourEl.textContent = String(alarmHour).padStart(2, '0');
    if (valMinuteEl) valMinuteEl.textContent = String(alarmMinute).padStart(2, '0');
  }

  function adjustHour(delta) {
    alarmHour = (alarmHour + delta + 24) % 24;
    updatePickerDisplay();
  }

  function adjustMinute(delta) {
    alarmMinute = (alarmMinute + delta + 60) % 60;
    updatePickerDisplay();
  }

  // Stepper Buttons
  const btnHourUp = document.getElementById('btn-hour-up');
  const btnHourDown = document.getElementById('btn-hour-down');
  const btnMinuteUp = document.getElementById('btn-minute-up');
  const btnMinuteDown = document.getElementById('btn-minute-down');

  if (btnHourUp) btnHourUp.addEventListener('click', () => adjustHour(1));
  if (btnHourDown) btnHourDown.addEventListener('click', () => adjustHour(-1));
  if (btnMinuteUp) btnMinuteUp.addEventListener('click', () => adjustMinute(1));
  if (btnMinuteDown) btnMinuteDown.addEventListener('click', () => adjustMinute(-1));

  // Touch Drag & Mouse Drag Controller for Wheels
  function bindPickerDrag(columnEl, onAdjust) {
    if (!columnEl) return;
    let startY = 0;

    const handleStart = (e) => {
      startY = e.touches ? e.touches[0].clientY : e.clientY;
    };

    const handleMove = (e) => {
      if (!startY) return;
      const currentY = e.touches ? e.touches[0].clientY : e.clientY;
      const diffY = startY - currentY;

      if (Math.abs(diffY) >= 12) {
        onAdjust(diffY > 0 ? 1 : -1);
        startY = currentY;
      }
    };

    const handleEnd = () => { startY = 0; };

    columnEl.addEventListener('touchstart', handleStart, { passive: true });
    columnEl.addEventListener('touchmove', handleMove, { passive: true });
    columnEl.addEventListener('touchend', handleEnd);

    columnEl.addEventListener('mousedown', handleStart);
    columnEl.addEventListener('mousemove', (e) => { if (e.buttons === 1) handleMove(e); });
    columnEl.addEventListener('mouseup', handleEnd);

    columnEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      onAdjust(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  bindPickerDrag(document.getElementById('picker-col-hour'), adjustHour);
  bindPickerDrag(document.getElementById('picker-col-minute'), adjustMinute);

  // Restore saved alarm
  const cachedAlarm = localStorage.getItem('SR-Light_alarm');
  if (cachedAlarm) {
    const [ch, cm] = cachedAlarm.split(':').map(Number);
    if (!isNaN(ch)) alarmHour = ch;
    if (!isNaN(cm)) alarmMinute = cm;
    updatePickerDisplay();
    valAlarm.textContent = cachedAlarm;
  }

  // Save Alarm Button
  saveAlarmBtn.addEventListener('click', async () => {
    const padHour = String(alarmHour).padStart(2, '0');
    const padMinute = String(alarmMinute).padStart(2, '0');
    const alarmTimeStr = `${padHour}:${padMinute}`;

    localStorage.setItem('SR-Light_alarm', alarmTimeStr);
    valAlarm.textContent = alarmTimeStr;

    const command = `FL+ALARM:${padHour}:${padMinute},1`;
    try {
      await bleManager.send(command);
      logToConsole(`保存 24 小时闹钟成功: ${alarmTimeStr}`, 'info');
    } catch (e) { }
  });

  // --- SUNRISE PRESET HANDLERS ---
  const presetCards = document.querySelectorAll('.sunrise-preset-card');
  let selectedPreset = 'natural';

  const PRESET_CONFIGS = {
    natural: { name: '自然晨曦', dur: 30, startK: 2700, endK: 4500 },
    energizing: { name: '强力唤醒', dur: 20, startK: 3000, endK: 6500 },
    gentle: { name: '柔光无感', dur: 45, startK: 2200, endK: 3500 }
  };

  presetCards.forEach(card => {
    card.addEventListener('click', () => {
      presetCards.forEach(c => {
        c.classList.remove('active');
        c.style.borderColor = 'rgba(255,255,255,0.1)';
        c.style.background = 'rgba(255,255,255,0.03)';
      });
      card.classList.add('active');
      card.style.borderColor = '#00e5ff';
      card.style.background = 'rgba(0,229,255,0.08)';
      selectedPreset = card.dataset.preset;
    });
  });

  const applyPresetBtn = document.getElementById('apply-preset-btn');
  if (applyPresetBtn) {
    applyPresetBtn.addEventListener('click', async () => {
      const cfg = PRESET_CONFIGS[selectedPreset] || PRESET_CONFIGS.natural;
      const startCctPercent = Math.max(0, Math.min(100, Math.round(((6500 - cfg.startK) / 3800) * 100)));
      const endCctPercent = Math.max(0, Math.min(100, Math.round(((6500 - cfg.endK) / 3800) * 100)));
      const command = `FL+SUN:${cfg.dur},${startCctPercent},${endCctPercent}`;

      try {
        await bleManager.send(command);
        logToConsole(`设置成功：已应用【${cfg.name}】模式 (${cfg.dur}分钟)`, 'info');
      } catch (e) {
        // Error logged
      }
    });
  }

  // Manual Brightness Slider
  brightnessSlider.addEventListener('input', (e) => {
    const value = Number(e.target.value);
    valBrightnessSlider.textContent = `${value}%`;
    valOutputCct.textContent = `${value}% 亮度 · ${getCctLabel(cctSlider.value)}`;
  });

  brightnessSlider.addEventListener('change', async (e) => {
    const value = Number(e.target.value);
    const command = `FL+BRIGHT:${value}`;
    try {
      await bleManager.send(command);
    } catch (e) { }
  });

  // Manual CCT Slider
  cctSlider.addEventListener('input', (e) => {
    const value = Number(e.target.value);
    valCctSlider.textContent = getCctLabel(value);
    valOutputCct.textContent = `${brightnessSlider.value}% 亮度 · ${getCctLabel(value)}`;
  });

  cctSlider.addEventListener('change', async (e) => {
    const value = Number(e.target.value);
    const cctPercent = Math.round(((6500 - value) / 3800) * 100);
    const command = `FL+CCT:${cctPercent}`;
    try {
      await bleManager.send(command);
    } catch (e) { }
  });

  // Console Clear
  const clearConsoles = () => {
    const emptyHtml = '<div style="color:var(--text-dimmed)">日志控制台已清空。</div>';
    if (bleConsole) bleConsole.innerHTML = emptyHtml;
    if (modalBleConsole) modalBleConsole.innerHTML = emptyHtml;
  };

  if (clearConsoleBtn) clearConsoleBtn.addEventListener('click', clearConsoles);
  if (modalClearConsoleBtn) modalClearConsoleBtn.addEventListener('click', clearConsoles);

  // --- MANUAL COMMAND SEND ---
  const sendFromInput = async (inputElement) => {
    if (!inputElement) return;
    const text = inputElement.value.trim();
    if (!text) return;

    try {
      await bleManager.send(text);
      inputElement.value = '';
    } catch (err) {
      logToConsole(`发送失败: ${err.message}`, 'error');
    }
  };

  if (manualSendBtn && manualSendInput) {
    manualSendBtn.addEventListener('click', () => sendFromInput(manualSendInput));
    manualSendInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendFromInput(manualSendInput);
    });
  }

  if (modalManualSendBtn && modalManualSendInput) {
    modalManualSendBtn.addEventListener('click', () => sendFromInput(modalManualSendInput));
    modalManualSendInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendFromInput(modalManualSendInput);
    });
  }

  // --- CONSOLE MODAL INTERACTION ---
  window.toggleConsoleModal = function (show = true) {
    const modal = document.getElementById('console-modal');
    const modalBleConsole = document.getElementById('modal-ble-console');
    if (!modal) return;
    if (show) {
      modal.classList.add('active');
      if (modalBleConsole) {
        modalBleConsole.scrollTop = modalBleConsole.scrollHeight;
      }
    } else {
      modal.classList.remove('active');
    }
  };

  if (expandConsoleBtn) {
    expandConsoleBtn.addEventListener('click', () => window.toggleConsoleModal(true));
  }
  if (consoleCloseX) {
    consoleCloseX.addEventListener('click', () => window.toggleConsoleModal(false));
  }
  if (consoleModal) {
    consoleModal.addEventListener('click', (e) => {
      if (e.target === consoleModal) window.toggleConsoleModal(false);
    });
  }

  // --- SETTINGS MODAL INTERACTION ---
  settingsToggleBtn.addEventListener('click', () => {
    settingsModal.classList.add('active');
  });

  const closeModal = () => {
    settingsModal.classList.remove('active');
  };

  settingsCloseX.addEventListener('click', closeModal);

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      closeModal();
    }
  });

  uuidResetBtn.addEventListener('click', () => {
    uuidServiceInput.value = '0000ffe0-0000-1000-8000-00805f9b34fb';
    uuidCharInput.value = '0000ffe1-0000-1000-8000-00805f9b34fb';
    logToConsole('重置 UUID 为 JDY-23 模组默认值。', 'info');
  });

  uuidSaveBtn.addEventListener('click', () => {
    const service = uuidServiceInput.value.trim();
    const char = uuidCharInput.value.trim();

    if (!service || !char) {
      logToConsole('UUID 不能为空', 'warn');
      return;
    }

    bleManager.updateUuids(service, char);
    closeModal();
    logToConsole('蓝牙 UUID 配置已保存。重新连接后将应用新配置。', 'info');
  });

  // --- INITIALIZATION WORKFLOW ---
  startClock();
  loadCachedSettings();
});

// --- PWA INSTALL BANNER SERVICE ---
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const banner = document.getElementById('pwa-install-banner');
  if (banner) {
    banner.style.display = 'flex';
  }
});

const pwaInstallBtn = document.getElementById('pwa-install-btn');
if (pwaInstallBtn) {
  pwaInstallBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`PWA install user outcome: ${outcome}`);
    deferredPrompt = null;
    const banner = document.getElementById('pwa-install-banner');
    if (banner) {
      banner.style.display = 'none';
    }
  });
}

// Service Worker Registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        console.log('SR-Light Web ServiceWorker registered successfully.', reg.scope);
      })
      .catch((err) => {
        console.error('SR-Light Web ServiceWorker registration failed: ', err);
      });
  });
}
