/**
 * Firefox Sidebar Polyfill
 *
 * Loaded as the FIRST script in tabs/sandbox.html (and options.html).
 *
 * Fixes applied:
 *  0. String.prototype.includes patch – detectEnvironment() returns "side_panel"
 *     Firefox can't redefine window.location (non-configurable). Instead we
 *     intercept String.prototype.includes so that when the compiled detector
 *     calls href.includes("chrome-extension://") on a moz-extension URL it
 *     gets true.
 *  0b.chrome.runtime.getURL patch – extension-id header extraction
 *     The compiled code does getURL("").replace("chrome-extension://","").replace("/","")
 *     to extract the extension UUID.  In Firefox getURL returns moz-extension://
 *     so the replace chain produces garbage. Fix: return chrome-extension:// for
 *     empty paths.
 *  1. window.chrome Proxy – falls back to browser.* for missing chrome.* APIs
 *  2. sendMessage null-extensionId fix – strips null/undefined first arg
 */

// ─── Fix 0: make detectEnvironment() return "side_panel" ────────────────────
//
// The compiled Plasmo env detector does:
//   window.location.href.includes("chrome-extension://") → "side_panel"
// In Firefox, extension pages have moz-extension:// URLs, so this returns false
// and detectEnvironment() falls through to "unknown".
//
// We CANNOT redefine window.location (TypeError: non-configurable).
// Instead, patch String.prototype.includes to treat moz-extension:// URLs
// as matching the "chrome-extension://" check.  This is narrowly scoped:
// it only triggers when the search target is exactly "chrome-extension://"
// AND the string being searched already contains "moz-extension://".
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  try {
    var _origIncludes = String.prototype.includes;
    String.prototype.includes = function (searchString) {
      // In sloppy mode, `this` is autoboxed to a String object, so
      // typeof this === 'object', not 'string'. Use String() to coerce.
      if (searchString === 'chrome-extension://' &&
          _origIncludes.call(String(this), 'moz-extension://')) {
        return true;
      }
      return _origIncludes.apply(this, arguments);
    };
  } catch (e) {
    console.warn('[FF sidebar polyfill] Could not patch String.prototype.includes:', e);
  }
})();

// ─── Fix 0b: chrome.runtime.getURL patch ────────────────────────────────────
//
// The compiled Axios interceptor does:
//   chrome.runtime.getURL("").replace("chrome-extension://","").replace("/","")
// to extract the extension UUID for the "extension-id" HTTP header.
// In Firefox, getURL returns "moz-extension://uuid/" which breaks the chain,
// producing "moz-extension:/uuid/" instead of "uuid".
//
// Fix: when getURL is called with an empty path, return the URL with a
// chrome-extension:// prefix.  Non-empty paths are left unchanged.
// Patched on both chrome.runtime and browser.runtime.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  function _patchGetURL(runtimeObj, label) {
    if (!runtimeObj || typeof runtimeObj.getURL !== 'function') return;
    var _origGetURL = runtimeObj.getURL.bind(runtimeObj);
    var _patched = function (path) {
      var url = _origGetURL(path || '');
      if (!path) {
        return url.replace('moz-extension://', 'chrome-extension://');
      }
      return url;
    };
    try {
      runtimeObj.getURL = _patched;
      if (runtimeObj.getURL === _patched) {
        return;
      }
    } catch (e) {}
    try {
      Object.defineProperty(runtimeObj, 'getURL', {
        value: _patched, writable: true, configurable: true, enumerable: true,
      });
    } catch (e) {
      console.warn('[FF sidebar polyfill] ✗ Could not patch ' + label + '.getURL');
    }
  }

  try {
    if (typeof browser !== 'undefined' && browser.runtime) {
      _patchGetURL(browser.runtime, 'browser.runtime');
    }
  } catch (e) {}
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      _patchGetURL(chrome.runtime, 'chrome.runtime');
    }
  } catch (e) {}
})();

// ─── Fix 0c: Ensure critical browser.* APIs are available on chrome ──────────
// Same as background polyfill Section -1: ensure chrome.scripting, chrome.tabs etc.
// are accessible. In the sidebar, the chrome Proxy (Fix 1) handles this for most
// cases, but we also bridge explicitly BEFORE the Proxy in case Proxy installation
// fails (it uses a fallback that only covers a fixed list of keys).
(function () {
  if (typeof browser === 'undefined' || typeof chrome === 'undefined') return;
  var apis = ['scripting', 'tabs', 'storage', 'cookies', 'webRequest',
              'commands', 'contextMenus', 'action', 'runtime'];
  apis.forEach(function (api) {
    if (chrome[api] === undefined && browser[api] !== undefined) {
      try { chrome[api] = browser[api]; } catch (e) {}
    }
  });
})();

// ─── Fix 0e: API shims for iframe context (web-accessible resource) ─────────
// When sandbox.html is loaded inside an iframe on a web page (floating overlay),
// Firefox does NOT provide chrome.tabs, chrome.scripting etc.
// Only runtime.sendMessage/connect/getURL are available.
//
// Detect this situation and create shims that delegate to the background
// via browser.runtime.sendMessage with special message names.
// The background's Section 15 handles these delegated calls.
(function () {
  // Determine the runtime to use for messaging
  var rt = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime :
           (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null;
  if (!rt || typeof rt.sendMessage !== 'function') return;

  // Check if chrome.tabs is truly unavailable (iframe context)
  var hasTabs = false;
  try {
    hasTabs = !!(chrome && chrome.tabs && typeof chrome.tabs.query === 'function');
  } catch (e) {}
  if (!hasTabs) {
    try {
      hasTabs = !!(typeof browser !== 'undefined' && browser.tabs && typeof browser.tabs.query === 'function');
    } catch (e) {}
  }

  if (hasTabs) return; // Full API available (sidebar context), no shim needed


  // Helper: send a proxy message to background and return the result
  function _proxyCall(name, body) {
    return rt.sendMessage({ name: name, body: body }).then(function (resp) {
      if (resp && resp.success) return resp.data;
      throw new Error((resp && resp.error) || 'Proxy call failed');
    });
  }

  // ── chrome.tabs shim ──
  var tabsShim = {
    query: function (queryInfo) {
      return _proxyCall('__FF_TABS_QUERY__', queryInfo);
    },
    sendMessage: function (tabId, message) {
      return _proxyCall('__FF_TABS_SEND_MESSAGE__', { tabId: tabId, message: message });
    },
    get: function (tabId) {
      return _proxyCall('__FF_TABS_GET__', { tabId: tabId });
    },
    create: function (createProperties) {
      return _proxyCall('__FF_TABS_CREATE__', createProperties);
    },
    update: function (tabId, updateProperties) {
      return _proxyCall('__FF_TABS_UPDATE__', { tabId: tabId, updateProperties: updateProperties });
    },
    remove: function (tabIds) {
      return _proxyCall('__FF_TABS_REMOVE__', { tabIds: tabIds });
    },
  };

  // Install on chrome object
  try {
    if (typeof chrome !== 'undefined') {
      if (!chrome.tabs) {
        chrome.tabs = tabsShim;
      }
    }
  } catch (e) {
    try {
      Object.defineProperty(chrome, 'tabs', {
        value: tabsShim, writable: true, configurable: true, enumerable: true,
      });
    } catch (e2) {
      console.warn('[FF sidebar polyfill] ✗ Could not install chrome.tabs shim:', e2);
    }
  }
})();

// ─── Fix 1: window.chrome Proxy ─────────────────────────────────────────────
(function () {
  if (typeof browser === 'undefined') {
    console.warn('[FF sidebar polyfill] browser API not available — skipping');
    return;
  }

  var origChrome = window.chrome;
  if (!origChrome) {
    console.warn('[FF sidebar polyfill] window.chrome not available — skipping');
    return;
  }

  // Proxy: for any property missing (undefined) on chrome, fall back to browser.
  var handler = {
    get: function (target, prop, receiver) {
      var val;
      try { val = Reflect.get(target, prop, receiver); } catch (e) { val = undefined; }
      if (val !== undefined && val !== null) return val;
      // Fall back to browser.*
      try {
        var bval = browser[prop];
        if (bval !== undefined) return bval;
      } catch (e) { /* ignore */ }
      return val;
    },
    // Allow the proxy to pass through set/has checks normally
    set: function (target, prop, value) {
      try { return Reflect.set(target, prop, value); } catch (e) { return false; }
    },
    has: function (target, prop) {
      if (Reflect.has(target, prop)) return true;
      try { return prop in browser; } catch (e) { return false; }
    },
  };

  try {
    var chromeProxy = new Proxy(origChrome, handler);

    // Try to replace window.chrome with the proxy.
    // Method 1: Object.defineProperty (works if chrome is a configurable property)
    try {
      Object.defineProperty(window, 'chrome', {
        get: function () { return chromeProxy; },
        configurable: true,
      });
      return;
    } catch (e1) { /* fall through */ }

    // Method 2: Direct assignment
    try {
      window.chrome = chromeProxy;
      return;
    } catch (e2) { /* fall through */ }

    console.warn('[FF sidebar polyfill] Could not replace window.chrome, trying per-key patching');
  } catch (proxyErr) {
    console.warn('[FF sidebar polyfill] Proxy creation failed:', proxyErr);
  }

  // Fallback: try to add individual missing keys to chrome directly
  var KEYS = ['tabs', 'scripting', 'action', 'storage', 'contextMenus', 'commands', 'cookies'];
  KEYS.forEach(function (key) {
    if (origChrome[key] !== undefined) return;
    if (typeof browser[key] === 'undefined') return;
    try {
      origChrome[key] = browser[key];
    } catch (e) {
      try {
        Object.defineProperty(origChrome, key, {
          value: browser[key], writable: true, configurable: true, enumerable: true,
        });
      } catch (e2) {
        console.warn('[FF sidebar polyfill] ✗ Failed to assign chrome.' + key, e, e2);
      }
    }
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2: Plasmo sendToBackground null extensionId
//
// Plasmo's sendToBackground(msg) compiles to:
//   browser.runtime.sendMessage(msg.extensionId ?? null, msg)
// When extensionId is absent, null is passed as the first arg.
//
// Firefox argument-normalisation: if the first argument is NOT a string,
// Firefox treats it as the MESSAGE (not as extensionId), so the actual
// message object ends up in the "options" slot and is never delivered to
// the background's onMessage listener → the Promise hangs forever →
// no error is thrown → clip / OCR / save-note silently do nothing.
//
// Fix: strip null/undefined first arg RELIABLY from both
// browser.runtime.sendMessage and chrome.runtime.sendMessage.
// Three escalating methods are tried; the last uses a globalThis Proxy.
// ─────────────────────────────────────────────────────────────────────────────
(function () {

  function _makeStrippedSend(origFn, thisArg) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      // Strip ONLY null/undefined first arg (Plasmo extensionId slot).
      // Do NOT strip objects — sendMessage(msgObj, callback) must be preserved.
      if (args.length >= 2 && (args[0] === null || args[0] === undefined)) {
        args = args.slice(1);
      }
      return origFn.apply(thisArg, args);
    };
  }

  // Returns true if the patch is verified to have taken effect.
  function _patchRuntime(runtimeObj, label) {
    if (!runtimeObj || typeof runtimeObj.sendMessage !== 'function') return false;
    var _orig    = runtimeObj.sendMessage.bind(runtimeObj);
    var _patched = _makeStrippedSend(_orig, runtimeObj);

    // Method 1: direct assignment
    try {
      runtimeObj.sendMessage = _patched;
      if (runtimeObj.sendMessage === _patched) {
        return true;
      }
    } catch (e1) { /* non-writable property — fall through */ }

    // Method 2: Object.defineProperty
    try {
      Object.defineProperty(runtimeObj, 'sendMessage', {
        value: _patched, writable: true, configurable: true, enumerable: true,
      });
      if (runtimeObj.sendMessage === _patched) {
        return true;
      }
    } catch (e2) { /* fall through */ }

    console.warn('[FF sidebar polyfill] ✗ Direct patch of ' + label + '.sendMessage failed');
    return false;
  }

  // ── browser.runtime ──────────────────────────────────────────────────────
  if (typeof browser !== 'undefined' && browser.runtime) {
    if (!_patchRuntime(browser.runtime, 'browser.runtime')) {
      // Method 3: override globalThis.browser with a transparent Proxy that
      // intercepts only runtime.sendMessage.  This is the last resort and
      // reliably works even if the native browser.runtime is sealed/frozen.
      try {
        var _origBrowser = globalThis.browser;
        var _origSend    = _origBrowser.runtime.sendMessage.bind(_origBrowser.runtime);
        var _patchedSend = _makeStrippedSend(_origSend, _origBrowser.runtime);

        var _rtProxy = new Proxy(_origBrowser.runtime, {
          get: function (t, p) {
            if (p === 'sendMessage') return _patchedSend;
            var v = t[p];
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });

        Object.defineProperty(globalThis, 'browser', {
          get: function () {
            return new Proxy(_origBrowser, {
              get: function (t, p) {
                if (p === 'runtime') return _rtProxy;
                var v = t[p];
                return typeof v === 'function' ? v.bind(t) : v;
              },
            });
          },
          configurable: true,
        });
      } catch (e3) {
        console.warn('[FF sidebar polyfill] ✗ All browser.runtime.sendMessage patches failed:', e3);
      }
    }
  }

  // ── chrome.runtime ───────────────────────────────────────────────────────
  try {
    if (typeof window !== 'undefined' && window.chrome && window.chrome.runtime) {
      _patchRuntime(window.chrome.runtime, 'chrome.runtime');
    }
  } catch (e) {
    console.warn('[FF sidebar polyfill] Could not patch chrome.runtime.sendMessage:', e);
  }

})();
