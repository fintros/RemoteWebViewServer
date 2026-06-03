import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual, readInjectScriptConfig } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { SelfTestRunner } from "./selfTest.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";

export type DeviceSession = {
  id: string;
  deviceId: string;
  cdp: CDPSession;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner

  // trailing throttle state
  pendingB64?: string;
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
};

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();

const ANTI_ANIMATION_SCRIPT = `
  (function() {
    const css = \`
      * { 
        animation: none !important; 
        transition: none !important; 
      }
      input, textarea, [contenteditable="true"] {
        caret-color: transparent !important;
      }
    \`;
    
    // 1. Применяем к обычному (Light) DOM
    function injectToNode(node) {
      if (node.querySelector('#rpi-anti-anim')) return;
      const style = document.createElement('style');
      style.id = 'rpi-anti-anim';
      style.innerHTML = css;
      // appendChild может не сработать моментально в shadow, поэтому используем prepend/append
      if (node.prepend) node.prepend(style);
      else node.appendChild(style);
    }
    
    if (document.head) injectToNode(document.head);
    
    // 2. ХАК ДЛЯ HOME ASSISTANT: Перехватываем создание Shadow DOM
    // Этот код внедрит наш CSS внутрь каждой карточки, кнопки и спиннера
    if (!window.__shadowPatched) {
      const originalAttachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(init) {
        const shadowRoot = originalAttachShadow.call(this, init);
        injectToNode(shadowRoot);
        return shadowRoot;
      };
      window.__shadowPatched = true;
    }
  })();
`;


export async function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {

  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  
  let sessionIsAlive = false;
  if (device) {
      try {
          await device.cdp.send('Browser.getVersion'); // Простой пинг
          sessionIsAlive = true;
      } catch (e) {
          console.warn(`[device] CDP session for ${id} is dead. Recreating.`);
          await deleteDeviceAsync(device);
          device = undefined;
      }
  }

  if (device && sessionIsAlive) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      device.processor.requestFullFrame();
      
      await device.cdp.send('Page.startScreencast', {
        format: 'png',
        maxWidth: cfg.width,
        maxHeight: cfg.height,
        everyNthFrame: cfg.everyNthFrame
      }).catch(e => console.error("Failed to restart screencast", e));

      return device;
    } else {
      console.log(`[device] Reconfiguring device ${id}`);
      await deleteDeviceAsync(device);
    }
  }

  const { targetInfos } = await root.send<{targetInfos: any[]}>('Target.getTargets');
  
  const mainPages = targetInfos.filter(t => 
      t.type === 'page' && 
      !t.openerId && 
      (!t.targetId.includes('iframe') && !t.url.includes('worker'))
  );

  let targetId: string;

  if (mainPages.length > 0) {
    const haPage = mainPages.find(t => t.url.includes(':8123'));
    
    if (haPage) {
        targetId = haPage.targetId;
        console.log(`[device] Reusing Home Assistant tab: ${targetId}`);
    } else {
        targetId = mainPages[0].targetId;
        console.log(`[device] Reusing empty tab: ${targetId}`);
    }

    for (const page of mainPages) {
      if (page.targetId !== targetId) {
        console.log(`[device] Killing extra main tab: ${page.targetId} (${page.url})`);
        await root.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
      }
    }
  } else {
    console.log(`[device] No main tabs found, creating a new one`);
    const res = await root.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      width: cfg.width,
      height: cfg.height,
    });
    targetId = res.targetId;
  }

  const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  });

  const session = (root as any).session(sessionId);

  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: cfg.width,
    height: cfg.height,
    deviceScaleFactor: 1,
    mobile: true
  });
  if (PREFERS_REDUCED_MOTION) {
    await session.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }

  // 1. Инжектируем отключение анимаций на каждый новый документ (при навигации)
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: ANTI_ANIMATION_SCRIPT });

  const keyboardScript = await getInjectScriptFromUrl(readInjectScriptConfig());
  if (keyboardScript) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: keyboardScript });
  }

  // 2. Инжектируем отключение анимаций прямо сейчас, если страница уже загружена
  await session.send('Runtime.evaluate', { expression: ANTI_ANIMATION_SCRIPT }).catch(() => {});

  await session.send('Page.startScreencast', {
    format: 'png',
    maxWidth: cfg.width,
    maxHeight: cfg.height,
    everyNthFrame: cfg.everyNthFrame
  });

  const processor = new FrameProcessor({
    tileSize: cfg.tileSize,
    fullframeTileCount: cfg.fullFrameTileCount,
    fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
    jpegQuality: cfg.jpegQuality,
    fullFrameEvery: cfg.fullFrameEvery,
    maxBytesPerMessage: cfg.maxBytesPerMessage,
  });

  const newDevice: DeviceSession = {
    id: targetId,
    deviceId: id,
    cdp: session,
    cfg: cfg,
    url: '',
    lastActive: Date.now(),
    frameId: 0,
    processor,
    selfTestRunner: new SelfTestRunner(broadcaster),
    pendingB64: undefined,
    throttleTimer: undefined,
    lastProcessedMs: undefined,
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  const flushPending = async () => {
    const dev = newDevice;
    dev.throttleTimer = undefined;

    const b64 = dev.pendingB64;
    dev.pendingB64 = undefined;
    if (!b64) return;

    try {
      const pngFull = Buffer.from(b64, 'base64');

      let img = sharp(pngFull);
      if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);

      const { data, info } = await img
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
        
      const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
      
      if (out.rects.length > 0) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
      }
    } catch (e) {
      console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
    } finally {
      dev.lastProcessedMs = Date.now();
    }
  };

  session.on('Page.screencastFrame', async (evt: any) => {
    // ACK immediately to keep producer running
    session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });

    if (broadcaster.getClientCount(newDevice.deviceId) === 0)
      return;
    newDevice.lastActive = Date.now();
    newDevice.pendingB64 = evt.data;

    const now = Date.now();
    const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
    if (!newDevice.throttleTimer) {
      const delay = Math.max(0, cfg.minFrameInterval - (Number.isFinite(since) ? since : 0));
      newDevice.throttleTimer = setTimeout(flushPending, delay);
    }
  });

  const handleNavigation = (url: string) => {
    if (newDevice.url !== url) {
      newDevice.url = url;
      broadcaster.sendCurrentURL(newDevice.deviceId, url);
      console.log(`[device] URL changed to: ${url}`);

      // ================= АВТОЛОГИН =================
      if (url.includes('/auth/authorize')) {
        if (!cfg.haUser || !cfg.haPass) {
          console.log(`[device] Login page detected, but haUser/haPass is missing in config!`);
          return;
        }

        console.log(`[device] Detected HA login page. Injecting credentials via deep CDP...`);

        // Ждем 5 секунд, пока HA полностью загрузится
        setTimeout(async () => {
          console.log("[device] Starting xdotool-style CDP auto-login sequence...");

          try {
            const typeText = async (text: string) => {
              for (const char of text) {
                await session.send('Input.dispatchKeyEvent', { type: 'char', text: char });
                await new Promise(r => setTimeout(r, 20));
              }
            };

            const pressKey = async (key: string, code: string, keyIdentifier: string) => {
              await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, keyIdentifier });
              await new Promise(r => setTimeout(r, 50));
              await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, keyIdentifier });
              await new Promise(r => setTimeout(r, 100));
            };

            console.log("[device] Typing username...");
            await typeText(cfg.haUser);
            await new Promise(r => setTimeout(r, 200));

            console.log("[device] Pressing Tab...");
            await pressKey('Tab', 'Tab', 'U+0009');
            await new Promise(r => setTimeout(r, 200));

            console.log("[device] Typing password...");
            await typeText(cfg.haPass);
            await new Promise(r => setTimeout(r, 500));

            console.log("[device] Pressing Tab to reach Submit button...");
            await pressKey('Tab', 'Tab', 'U+0009');
            await pressKey('Tab', 'Tab', 'U+0009');
            await pressKey('Tab', 'Tab', 'U+0009');
            await pressKey('Tab', 'Tab', 'U+0009');
            await new Promise(r => setTimeout(r, 300));

            console.log("[device] Pressing Enter to submit...");
            await pressKey('Enter', 'Enter', 'Enter');
            await pressKey(' ', 'Space', 'U+0020'); 

            console.log("[device] Credentials injected via CDP keystrokes. Waiting for redirect...");

            setTimeout(async () => {
                await session.send('Page.stopScreencast').catch(() => {});
                
                // 3. После логина принудительно гасим анимации еще раз (на случай, если HA отрендерил новый SPA-контекст)
                await session.send('Runtime.evaluate', { expression: ANTI_ANIMATION_SCRIPT }).catch(() => {});

                await session.send('Page.startScreencast', {
                  format: 'png',
                  maxWidth: cfg.width,
                  maxHeight: cfg.height,
                  everyNthFrame: cfg.everyNthFrame
                }).catch(() => {});

                newDevice.processor.requestFullFrame();
            }, 5000);

          } catch (e: any) {
            console.error(`[device] CDP xdotool-style login failed:`, e);
          }
        }, 5000); 

      }
      // ================= КОНЕЦ АВТОЛОГИНА =================
    }
  };

  session.on('Page.frameNavigated', (evt: any) => {
    if (!evt.frame.parentId) {
      handleNavigation(evt.frame.url);
    }
  });
  session.on('Page.navigatedWithinDocument', (evt: any) => {
    handleNavigation(evt.url);
  });
  
  return newDevice;
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;

  try {
    const now = Date.now();
    const staleIds = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs)
      .map(d => d.deviceId);

    for (const id of staleIds) {
      const dev = devices.get(id);
      if (!dev) continue;

      console.log(`[device] Cleaning up idle device ${id}`);
      await deleteDeviceAsync(dev).catch(() => { /* swallow */ });
    }
  } finally {
    _cleanupRunning = false;
  }
}

async function deleteDeviceAsync(device: DeviceSession) {
  const root = getRoot();

  if (!devices.delete(device.deviceId))
    return;

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);

  try { await device.cdp.send("Page.stopScreencast").catch(() => { }); } catch { }
  try { await root?.send("Target.closeTarget", { targetId: device.id }); } catch { }
}