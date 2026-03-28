/**
 * Firefox Content Script Polyfill
 *
 * Loaded as the FIRST content script (run_at: document_start) on all pages.
 *
 * Fixes applied:
 *  0. String.prototype.includes patch – makes detectEnvironment() work
 *     when compiled code checks href.includes("chrome-extension://")
 *  1. chrome.runtime.getURL patch – extension-id header extraction
 *     Returns chrome-extension:// prefix for empty paths so the
 *     .replace("chrome-extension://","").replace("/","") chain produces the UUID.
 *  2. sendMessage null-extensionId fix – strips null/undefined first arg
 *     Uses three escalating methods (assign → defineProperty → Proxy)
 *  3. Chrome API bridging – ensures chrome.* APIs fall back to browser.*
 *  4. Diagnostic logging for sendToBackground calls
 */

// ─── Fix 0: make detectEnvironment() work for content scripts ───────────────
// The compiled Plasmo env detector does:
//   window.location.href.includes("chrome-extension://") → environment type
// In Firefox, extension pages use moz-extension:// URLs.
// Content scripts run on web pages (http/https), so this is mainly relevant
// when content script code checks getURL("") results.
// Narrowly scoped: only triggers when search is "chrome-extension://"
// AND the string contains "moz-extension://".
(function () {
  try {
    var _origIncludes = String.prototype.includes;
    String.prototype.includes = function (searchString) {
      if (searchString === 'chrome-extension://' &&
          _origIncludes.call(String(this), 'moz-extension://')) {
        return true;
      }
      return _origIncludes.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }
})();

// ─── Fix 1: chrome.runtime.getURL patch ─────────────────────────────────────
// The compiled code does:
//   chrome.runtime.getURL("").replace("chrome-extension://","").replace("/","")
// to extract the extension UUID for HTTP headers.
// In Firefox, getURL returns "moz-extension://uuid/" which breaks this chain.
// Fix: when getURL is called with an empty path, return chrome-extension:// URL.
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
      if (runtimeObj.getURL === _patched) return;
    } catch (e) {}
    try {
      Object.defineProperty(runtimeObj, 'getURL', {
        value: _patched, writable: true, configurable: true, enumerable: true,
      });
    } catch (e) {}
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

// ─── Fix 2: sendMessage null-extensionId fix (robust, 3 methods) ────────────
// Plasmo's sendToBackground(msg) compiles to:
//   browser.runtime.sendMessage(msg.extensionId ?? null, msg)
// When extensionId is absent, null is the first arg.
// Firefox doesn't normalise null → message hangs forever.
// Uses three escalating methods to ensure the patch takes effect.
(function () {
  'use strict';

  function _makeStrippedSend(origFn, thisArg) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      if (args.length >= 2 && (args[0] === null || args[0] === undefined)) {
        args = args.slice(1);
      }
      return origFn.apply(thisArg, args);
    };
  }

  function _patchRuntime(runtimeObj, label) {
    if (!runtimeObj || typeof runtimeObj.sendMessage !== 'function') return false;
    var _orig = runtimeObj.sendMessage.bind(runtimeObj);
    var _patched = _makeStrippedSend(_orig, runtimeObj);

    // Method 1: direct assignment
    try {
      runtimeObj.sendMessage = _patched;
      if (runtimeObj.sendMessage === _patched) return true;
    } catch (e) {}

    // Method 2: Object.defineProperty
    try {
      Object.defineProperty(runtimeObj, 'sendMessage', {
        value: _patched, writable: true, configurable: true, enumerable: true,
      });
      if (runtimeObj.sendMessage === _patched) return true;
    } catch (e) {}

    return false;
  }

  // ── browser.runtime ──────────────────────────────────────────────────────
  if (typeof browser !== 'undefined' && browser.runtime) {
    if (!_patchRuntime(browser.runtime, 'browser.runtime')) {
      // Method 3: globalThis Proxy (last resort for sealed/frozen runtime)
      try {
        var _origBrowser = globalThis.browser;
        var _origSend = _origBrowser.runtime.sendMessage.bind(_origBrowser.runtime);
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
      } catch (e) { /* all methods failed */ }
    }
  }

  // ── chrome.runtime ───────────────────────────────────────────────────────
  try {
    if (typeof window !== 'undefined' && window.chrome && window.chrome.runtime) {
      _patchRuntime(window.chrome.runtime, 'chrome.runtime');
    }
  } catch (e) {}
})();

// ─── Fix 3: Chrome API bridging ─────────────────────────────────────────────
// Ensure chrome.* APIs fall back to browser.* for content scripts.
// app.d8f06386.js may access chrome.tabs, chrome.scripting etc.
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

// ─── Fix 5: Floating ball hover area fix ─────────────────────────────────────
// The floating ball's Wrapper div uses `position:fixed; right:0` without an
// explicit width, so its layout area can overlap the panel iframe causing
// unwanted hover-expand. Fix: inject CSS into the ball's shadow DOM to
// constrain the Wrapper to fit-content width.
(function () {
  var BALL_CSS =
    '/* Fix: constrain floating ball Wrapper to its content width\n' +
    '   so hover area does not overlap the panel iframe.\n' +
    '   Wrapper is styled-component div (position:fixed;right:0)\n' +
    '   with BallEntry[data-tour="levitate-ball"] as direct child. */\n' +
    'div:has(> [data-tour="levitate-ball"]) {\n' +
    '  width: fit-content !important;\n' +
    '}\n';

  function injectIntoBallShadow(host) {
    var shadow = host.shadowRoot;
    if (!shadow) return;
    if (shadow.querySelector('#ff-ball-fix')) return;
    var style = document.createElement('style');
    style.id = 'ff-ball-fix';
    style.textContent = BALL_CSS;
    shadow.appendChild(style);
  }

  // Observe for the csui-app element (may not exist yet at document_start)
  function tryInject() {
    var el = document.getElementById('csui-app');
    if (el) { injectIntoBallShadow(el); return true; }
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (!tryInject()) {
        // Element may be created after DOMContentLoaded by requestIdleCallback
        var obs = new MutationObserver(function (mutations, observer) {
          if (tryInject()) observer.disconnect();
        });
        obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
        // Safety timeout: stop observing after 30s
        setTimeout(function () { obs.disconnect(); }, 30000);
      }
    });
  } else {
    if (!tryInject()) {
      var obs = new MutationObserver(function (mutations, observer) {
        if (tryInject()) observer.disconnect();
      });
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
      setTimeout(function () { obs.disconnect(); }, 30000);
    }
  }
})();

