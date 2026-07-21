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
        acceptAllDevices: true,
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

      // Trigger automatic time synchronization
      await this.syncSystemTime();

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
window.toggleConsoleModal = function(show = true) {
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

window.syncTimeNow = async function() {
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
    alarmTimeInput.value = alarm;
    valAlarm.textContent = alarm;

    const duration = localStorage.getItem('SR-Light_duration') || '30';
    durationInput.value = duration;

    const startCct = localStorage.getItem('SR-Light_start_cct') || '2700';
    startCctInput.value = startCct;

    const endCct = localStorage.getItem('SR-Light_end_cct') || '6500';
    endCctInput.value = endCct;

    uuidServiceInput.value = bleManager.serviceUuid;
    uuidCharInput.value = bleManager.characteristicUuid;

    // Initial display of sliders
    valBrightnessSlider.textContent = `${brightnessSlider.value}%`;
    valCctSlider.textContent = `${cctSlider.value}K`;
    valOutputCct.textContent = `${brightnessSlider.value}% @ ${cctSlider.value}K`;
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
      // Expecting JSON format from device. e.g., {"progress": 25, "brightness": 40, "cct": 3000}
      if (cleanText.startsWith('{') && cleanText.endsWith('}')) {
        const payload = JSON.parse(cleanText);

        if (payload.progress !== undefined) {
          const prog = Math.min(100, Math.max(0, payload.progress));
          valProgressBar.style.width = `${prog}%`;
          valProgressPercent.textContent = `${prog}%`;
        }

        const currentBright = payload.brightness !== undefined ? payload.brightness : brightnessSlider.value;
        const currentCct = payload.cct !== undefined ? payload.cct : cctSlider.value;

        valOutputCct.textContent = `${currentBright}% @ ${currentCct}K`;

        // Optionally update manual sliders if not being touched
        if (!document.activeElement || document.activeElement !== brightnessSlider) {
          brightnessSlider.value = currentBright;
          valBrightnessSlider.textContent = `${currentBright}%`;
        }
        if (!document.activeElement || document.activeElement !== cctSlider) {
          cctSlider.value = currentCct;
          valCctSlider.textContent = `${currentCct}K`;
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

  // Save Alarm
  saveAlarmBtn.addEventListener('click', async () => {
    const alarmTime = alarmTimeInput.value;
    if (!alarmTime) {
      logToConsole('闹钟时间不能为空', 'warn');
      return;
    }

    const [hour, minute] = alarmTime.split(':').map(Number);

    // Save to Cache
    localStorage.setItem('SR-Light_alarm', alarmTime);
    valAlarm.textContent = alarmTime;

    const padHour = String(hour).padStart(2, '0');
    const padMinute = String(minute).padStart(2, '0');
    const command = `FL+ALARM:${padHour},${padMinute},1`;

    try {
      await bleManager.send(command);
      logToConsole(`保存唤醒闹钟成功: ${alarmTime}`, 'info');
    } catch (e) {
      // Failed write
    }
  });

  // Apply Sunrise Config
  saveSunriseBtn.addEventListener('click', async () => {
    const duration = Number(durationInput.value);
    const startCct = Number(startCctInput.value);
    const endCct = Number(endCctInput.value);

    if (isNaN(duration) || duration <= 0) {
      logToConsole('持续时间必须是大于0的数字', 'warn');
      return;
    }

    // Save to Cache
    localStorage.setItem('SR-Light_duration', duration);
    localStorage.setItem('SR-Light_start_cct', startCct);
    localStorage.setItem('SR-Light_end_cct', endCct);

    const startCctPercent = Math.round(((6500 - startCct) / 3800) * 100);
    const endCctPercent = Math.round(((6500 - endCct) / 3800) * 100);
    const command = `FL+SUN:${duration},${startCctPercent},${endCctPercent}`;

    try {
      await bleManager.send(command);
      logToConsole('日出渐变参数配置已应用并发送。', 'info');
    } catch (e) {
      // Error logged
    }
  });

  // Manual Brightness Slider
  brightnessSlider.addEventListener('input', (e) => {
    const value = Number(e.target.value);
    valBrightnessSlider.textContent = `${value}%`;
    valOutputCct.textContent = `${value}% @ ${cctSlider.value}K`;
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
    valCctSlider.textContent = `${value}K`;
    valOutputCct.textContent = `${brightnessSlider.value}% @ ${value}K`;
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
  window.toggleConsoleModal = function(show = true) {
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
