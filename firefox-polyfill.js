/**
 * Firefox Compatibility Polyfill for Yuque Browser Extension
 *
 * Loaded as the FIRST script in "background.scripts" (manifest.json).
 *
 * Patches applied
 * ───────────────
 *  0. chrome.runtime.onMessage.addListener – fix async listener bug (ROOT FIX)
 *  1. chrome.declarativeNetRequest  – enum namespaces Firefox may omit
 *  2. chrome.sidePanel             – mapped to browser.sidebarAction
 *  3. chrome.offscreen             – no-op stub
 *  4. chrome.runtime.getContexts   – stub returning []
 *  5. chrome.runtime.onMessageExternal – no-op stub if missing
 *  5b.chrome.debugger              – graceful no-op stubs
 *  6. chrome.cookies.getAll        – strip unsupported partitionKey
 *  7. chrome.runtime.getURL        – fix extension-id header extraction
 *  8. chrome.webRequest.onCompleted.addListener – fix empty urls[] bug
 *  9. chrome.runtime.sendMessage   – intercept bridge/* messages locally;
 *                                    normalize null extensionId (Plasmo fix)
 * 10. XMLHttpRequest auto cookie   – inject yuque cookies into background XHR
 * 11. bridge/document onMessage    – DocumentAPI for external callers
 * 12. bridge/background onMessage  – routes sidebar/content-script bridge requests
 * 13. chrome.commands.onCommand.addListener – inject active Tab as 2nd arg
 *                                    (Firefox only passes command, not tab)
 * 14. chrome.commands.onCommand    – open_sidepanel → sidebarAction.open
 *
 * Login failure root causes (fixed here)
 * ───────────────────────────────────────
 * A) [ROOT] Async onMessage listener bug:
 *    The compiled App class registers an `async onMessageListener`. In Firefox,
 *    async listeners return a Promise; Firefox uses the resolved value (true) as
 *    the response and ignores internal sendResponse() calls. Result: the sidebar
 *    receives `true` instead of {success:true,data:...} → proxy throws Error().
 *    Fix (section 0): wrap addListener so async listeners return `true`
 *    synchronously, keeping the channel open for the internal sendResponse call.
 *
 * B) Bridge self-messaging: background.scripts → window defined →
 *    isBackground=false → chromeApi proxy sends bridge messages to itself →
 *    background cannot receive own messages. Fix: sendMessage interceptor.
 *
 * C) extension-id header: compiled code does
 *    getURL("").replace("chrome-extension://","").replace("/","")
 *    → in Firefox produces "moz-extension:/uuid/" (malformed).
 *    Fix: patch getURL("") to return chrome-extension:// format.
 *
 * D) commands.onCommand tab argument missing:
 *    Firefox commands.onCommand passes only (command: string).
 *    Chrome/Edge passes (command: string, tab: Tab).
 *    The compiled onCommandListener(e, t) accesses t.id without a null guard,
 *    causing a TypeError that silently breaks selectArea/startOcr/clipPage.
 *    Fix (section 11): wrap addListener to inject the active Tab as 2nd arg.
 *
 * E) Plasmo sendToBackground null extensionId:
 *    Plasmo's sendToBackground calls sendMessage(e.extensionId ?? null, msg).
 *    When extensionId is absent, null is the first arg. Firefox may not treat
 *    null as "omitted extensionId" (Chrome does), so the message fails to
 *    reach the background's onMessage router, breaking httpRequest and all
 *    sendToBackground calls from content scripts.
 *    Fix (section 9): strip null/non-string first arg before forwarding.
 */

'use strict';

// Module-level state (referenced by sections 0, 9, and bridge router)
var _localListeners = [];  // populated by section 0; used by _deliverLocal
var _deliverLocal;         // assigned by section 9 IIFE; used by bridge router

// ─────────────────────────────────────────────────────────────────────────────
// -1. Ensure ALL browser.* APIs are accessible via chrome.* in Firefox
//
//     Firefox's chrome compatibility layer MAY NOT include newer APIs like
//     chrome.scripting (even though browser.scripting is available).
//     The compiled background code uses chrome.scripting.executeScript,
//     chrome.tabs.query, chrome.tabs.captureVisibleTab, etc. If these are
//     missing from the chrome object, ALL features that interact with
//     content scripts (clip, OCR, full-text extraction) will fail silently.
//
//     Fix: for each critical API, check if chrome.X is missing and browser.X
//     exists, and bridge them.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  if (typeof browser === 'undefined') return;
  var apis = ['scripting', 'tabs', 'storage', 'cookies', 'webRequest',
              'commands', 'contextMenus', 'action', 'notifications',
              'windows', 'i18n', 'alarms', 'permissions'];
  apis.forEach(function (api) {
    if (chrome[api] === undefined && browser[api] !== undefined) {
      try {
        chrome[api] = browser[api];

      } catch (e) {
        try {
          Object.defineProperty(chrome, api, {
            value: browser[api], writable: true, configurable: true, enumerable: true,
          });

        } catch (e2) {
          console.warn('[FF polyfill] ✗ Could not bridge chrome.' + api + ':', e2);
        }
      }
    }
  });

  // Verify critical APIs
  if (chrome.scripting && typeof chrome.scripting.executeScript === 'function') {

  } else {
    console.error('[FF polyfill] ✗ chrome.scripting.executeScript is NOT available after bridging!');
  }
  if (chrome.tabs && typeof chrome.tabs.query === 'function') {

  } else {
    console.error('[FF polyfill] ✗ chrome.tabs.query is NOT available after bridging!');
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// 0. chrome.runtime.onMessage.addListener – fix async listener in Firefox
//
//    The compiled App class registers:
//      chrome.runtime.onMessage.addListener(this.onMessageListener.bind(this))
//    where onMessageListener is declared `async`. In Firefox, an async listener
//    returns a Promise; Firefox uses the resolved value of that Promise as the
//    response to sendMessage, IGNORING any manual sendResponse() calls inside.
//    The async listener resolves to `true` (its last return statement), so the
//    sidebar receives `true` instead of {success:true, data:...}.
//
//    Fix: wrap addListener so that when a registered listener returns a Promise,
//    we substitute `true` as the synchronous return value instead. This keeps
//    the message channel open (Firefox/Chrome spec: returning `true` means
//    "I will call sendResponse asynchronously"), so the internal sendResponse()
//    calls inside the async function ARE received by the sender.
//
//    Also: keep a _localListeners array of wrapped listeners so that section 9's
//    sendMessage interceptor can deliver background→background messages locally
//    (Firefox background.scripts cannot receive their own sendMessage calls).
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  var _origAdd = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
  chrome.runtime.onMessage.addListener = function (listener) {
    var wrapper = function (msg, sender, sendResponse) {
      var result;
      try {
        result = listener(msg, sender, sendResponse);
      } catch (e) {
        console.warn('[FF polyfill] onMessage listener threw synchronously:', e);
        return false;
      }
      // If the listener returned a Promise (i.e. it is an async function),
      // return `true` instead so the channel stays open for sendResponse().
      if (result && typeof result.then === 'function') {
        result.catch(function (e) {
          console.warn('[FF polyfill] async onMessage listener rejected:', e);
        });
        return true;
      }
      return result;
    };
    _localListeners.push(wrapper);
    return _origAdd(wrapper);
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// 1. chrome.declarativeNetRequest – enum namespaces + domains→initiatorDomains
//
//    Firefox uses "initiatorDomains" where Chrome uses "domains" in rule
//    conditions. The compiled updateDynamicRules calls use condition.domains
//    which Firefox rejects with "Unexpected property domains".
//    Fix: patch updateDynamicRules to rename domains→initiatorDomains and
//    wrap in try/catch so errors don't propagate as unhandled rejections.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var dnr = chrome.declarativeNetRequest;
  if (!dnr) return;
  if (!dnr.RuleActionType) {
    dnr.RuleActionType = {
      BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow',
      UPGRADE_SCHEME: 'upgradeScheme', MODIFY_HEADERS: 'modifyHeaders',
      ALLOW_ALL_REQUESTS: 'allowAllRequests',
    };
  }
  if (!dnr.HeaderOperation) {
    dnr.HeaderOperation = { APPEND: 'append', SET: 'set', REMOVE: 'remove' };
  }
  if (!dnr.ResourceType) {
    dnr.ResourceType = {
      MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame', STYLESHEET: 'stylesheet',
      SCRIPT: 'script', IMAGE: 'image', FONT: 'font', OBJECT: 'object',
      XMLHTTPREQUEST: 'xmlhttprequest', PING: 'ping', CSP_REPORT: 'csp_report',
      MEDIA: 'media', WEBSOCKET: 'websocket', OTHER: 'other',
    };
  }

  // Patch updateDynamicRules: rename condition.domains → condition.initiatorDomains
  if (typeof dnr.updateDynamicRules === 'function') {
    var _origUDR = dnr.updateDynamicRules.bind(dnr);
    dnr.updateDynamicRules = function (options, callback) {
      try {
        if (options && Array.isArray(options.addRules)) {
          options = Object.assign({}, options);
          options.addRules = options.addRules.map(function (rule) {
            if (!rule || !rule.condition) return rule;
            rule = JSON.parse(JSON.stringify(rule));
            // Rename domains → initiatorDomains (Chrome → Firefox)
            if (rule.condition.domains) {
              rule.condition.initiatorDomains = rule.condition.domains;
              delete rule.condition.domains;
            }
            // Filter out invalid domain values (e.g. extension IDs containing @)
            if (Array.isArray(rule.condition.initiatorDomains)) {
              rule.condition.initiatorDomains = rule.condition.initiatorDomains.filter(function (d) {
                return typeof d === 'string' && d.length > 0 && d.indexOf('@') === -1;
              });
              // If all domains were invalid, remove the condition to avoid empty-array errors
              if (rule.condition.initiatorDomains.length === 0) {
                delete rule.condition.initiatorDomains;
              }
            }
            return rule;
          });
        }
        var result = typeof callback === 'function'
          ? _origUDR(options, callback)
          : _origUDR(options);
        if (result && typeof result.catch === 'function') {
          result.catch(function (e) {
            console.warn('[FF polyfill] declarativeNetRequest.updateDynamicRules failed (suppressed):', e && e.message);
          });
        }
        return result;
      } catch (e) {
        console.warn('[FF polyfill] declarativeNetRequest.updateDynamicRules threw (suppressed):', e && e.message);
        return Promise.resolve();
      }
    };
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// 2. chrome.sidePanel → browser.sidebarAction
// ─────────────────────────────────────────────────────────────────────────────
if (!chrome.sidePanel) {
  chrome.sidePanel = {
    open: function (options, callback) {
      return Promise.resolve()
        .then(function () {
          if (typeof browser !== 'undefined' && browser.sidebarAction &&
              typeof browser.sidebarAction.open === 'function') {
            return browser.sidebarAction.open();
          }
        })
        .then(function () { if (typeof callback === 'function') callback(); })
        .catch(function (e) {
          console.warn('[FF polyfill] sidebarAction.open failed:', e);
          if (typeof callback === 'function') callback();
        });
    },
    setOptions: function (options) {
      return Promise.resolve()
        .then(function () {
          if (options && options.enabled === false &&
              typeof browser !== 'undefined' && browser.sidebarAction &&
              typeof browser.sidebarAction.close === 'function') {
            return browser.sidebarAction.close();
          }
        })
        .catch(function (e) {
          console.warn('[FF polyfill] sidebarAction.setOptions failed:', e);
        });
    },
    getOptions: function () { return Promise.resolve({ enabled: true }); },
    setPanelBehavior: function () { return Promise.resolve(); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. chrome.offscreen → no-op stub
// ─────────────────────────────────────────────────────────────────────────────
if (!chrome.offscreen) {
  chrome.offscreen = {
    createDocument: function () { return Promise.resolve(); },
    closeDocument: function () { return Promise.resolve(); },
    hasDocument: function () { return Promise.resolve(false); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. chrome.runtime.getContexts → always stub returning []
//
//    Firefox 121+ HAS runtime.getContexts, but does NOT support the
//    "OFFSCREEN_DOCUMENT" contextType enum — it throws:
//      "Invalid enumeration value OFFSCREEN_DOCUMENT"
//    The compiled initOffscreen() calls:
//      chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"], ...})
//    We ALWAYS replace getContexts with a stub that returns [] (empty),
//    which causes initOffscreen to proceed to createDocument (our no-op stub).
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.getContexts = function () { return Promise.resolve([]); };

// ─────────────────────────────────────────────────────────────────────────────
// 5. chrome.runtime.onMessageExternal → no-op stub if not available
//
//    The compiled background script calls:
//      chrome.runtime.onMessageExternal.addListener(...)
//    If onMessageExternal is undefined (some Firefox versions), this throws
//    a TypeError that prevents chrome.runtime.onMessage.addListener from
//    being registered, breaking ALL background message routing.
// ─────────────────────────────────────────────────────────────────────────────
if (!chrome.runtime.onMessageExternal) {
  chrome.runtime.onMessageExternal = {
    addListener:    function () {},
    removeListener: function () {},
    hasListener:    function () { return false; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b. chrome.debugger → graceful no-op stubs
// ─────────────────────────────────────────────────────────────────────────────
if (!chrome.debugger) {
  chrome.debugger = {
    attach: function (t, v, cb) { if (typeof cb === 'function') cb(); return Promise.resolve(); },
    detach: function (t, cb)    { if (typeof cb === 'function') cb(); return Promise.resolve(); },
    sendCommand: function (t, m, p, cb) {
      var r = {}; if (typeof cb === 'function') cb(r); return Promise.resolve(r);
    },
    onEvent:  { addListener: function(){}, removeListener: function(){}, hasListener: function(){ return false; } },
    onDetach: { addListener: function(){}, removeListener: function(){}, hasListener: function(){ return false; } },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. chrome.cookies.getAll → strip unsupported partitionKey
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var _orig = chrome.cookies.getAll.bind(chrome.cookies);
  chrome.cookies.getAll = function (details, callback) {
    var clean = Object.assign({}, details);
    delete clean.partitionKey;
    return typeof callback === 'function' ? _orig(clean, callback) : _orig(clean);
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// 7. chrome.runtime.getURL – fix extension-id header extraction
//
//    The compiled HTTP client does:
//      chrome.runtime.getURL("").replace("chrome-extension://","").replace("/","")
//    In Firefox, getURL returns "moz-extension://uuid/" so the replace chain
//    produces the malformed string "moz-extension:/uuid/".
//    Fix: when called with an empty path (the only case used for this extraction),
//    return the URL with "chrome-extension://" prefix so the replace works correctly.
//    All non-empty paths return the real moz-extension:// URL unchanged.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var _origGetURL = chrome.runtime.getURL.bind(chrome.runtime);
  chrome.runtime.getURL = function (path) {
    var url = _origGetURL(path || '');
    if (!path) {
      return url.replace('moz-extension://', 'chrome-extension://');
    }
    return url;
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// 8. chrome.webRequest.onCompleted.addListener – fix empty urls[] bug
//
//    openYuqueLogin() in the compiled code calls:
//      chrome.webRequest.onCompleted.addListener(fn, {urls: [], tabId: id})
//    Firefox throws on empty urls. Default to <all_urls>.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var _orig = chrome.webRequest.onCompleted.addListener.bind(chrome.webRequest.onCompleted);
  chrome.webRequest.onCompleted.addListener = function (listener, filter, extraInfoSpec) {
    if (filter && Array.isArray(filter.urls) && filter.urls.length === 0) {
      filter = Object.assign({}, filter, { urls: ['<all_urls>'] });
    }
    return _orig(listener, filter, extraInfoSpec);
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// 9. chrome.runtime.sendMessage interceptor  ← ROOT FIX for bridge self-messaging
//
//    Two problems solved here:
//
//    A) Plasmo sendToBackground null extensionId:
//       Plasmo's sendToBackground() calls sendMessage(e.extensionId ?? null, msg).
//       When extensionId is absent null is passed as the 1st arg; Firefox may not
//       treat null as "omitted extensionId" (Chrome does), so the message fails.
//       Fix: strip ONLY null/undefined first arg — never strip message objects.
//
//    B) Firefox background self-messaging:
//       The background environment has window defined, so the Plasmo env detection
//       returns "unknown" (not "background"), making isBackground=false.  Every
//       ChromeAPI call therefore goes through the bridge proxy, which calls
//       sendMessage() from background to background.  Firefox background.scripts
//       CANNOT receive their own sendMessage calls ("Receiving end does not exist").
//       Fix: for any plain message (not bridge/*), deliver directly to the
//       _localListeners array tracked in section 0 instead of calling _orig.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var _orig = chrome.runtime.sendMessage.bind(chrome.runtime);

  // Deliver a message synchronously to all registered local onMessage listeners.
  // Assigned to module-level _deliverLocal so the bridge router (after section 11)
  // can also use it for sidebar→background routed messages.
  _deliverLocal = function _deliverLocal(msg) {
    return new Promise(function (resolve) {
      var responded = false;
      var sendResponse = function (response) {
        if (!responded) { responded = true; resolve(response); }
      };
      var asyncOpen = false;
      var fakeBackgroundSender = {
        id:     chrome.runtime.id,
        url:    chrome.runtime.getURL('_generated_background_page.html'),
        origin: 'null',
      };
      for (var i = 0; i < _localListeners.length; i++) {
        try {
          var ret = _localListeners[i](msg, fakeBackgroundSender, sendResponse);
          if (ret === true || (ret && typeof ret.then === 'function')) {
            asyncOpen = true;
          }
        } catch (e) {
          console.warn('[FF polyfill] local listener threw:', e);
        }
      }
      // If no listener signalled async and no response yet, resolve with undefined.
      if (!asyncOpen && !responded) { resolve(undefined); }
    });
  }

  chrome.runtime.sendMessage = function () {
    var args = Array.prototype.slice.call(arguments);

    // Normalize: strip ONLY null/undefined first arg (Plasmo extensionId slot).
    // Do NOT strip objects — sendMessage(msgObj, callback) must be preserved.
    if (args.length >= 2 && (args[0] === null || args[0] === undefined)) {
      args = args.slice(1);
    }

    var msg = (typeof args[0] === 'object' && args[0] !== null) ? args[0] : null;

    // Intercept bridge/* messages — handle locally without going to the network.
    if (msg && (msg.name === 'bridge/background' || msg.name === 'bridge/document')) {
      var method = msg.body && msg.body.method;
      var margs  = (msg.body && msg.body.args) || [];
      var isDoc  = _DOCUMENT_API_METHODS.indexOf(method) !== -1;
      var isChr  = _CHROME_API_METHODS.indexOf(method) !== -1;
      if (isDoc || isChr) {
        var handler = isDoc ? _handleDocumentApiMethod : _handleChromeApiMethod;
        return handler(method, margs)
          .then(function (result) { return { success: true,  data: result }; })
          .catch(function (err)   { return { success: false, error: (err && err.message) || String(err) }; });
      }
      // For all other methods (httpRequest, clip, screenshot, etc.):
      // The background's onMessage switch handles {name:"httpRequest", url:"...", method:"GET", ...}
      // at the ROOT level — it has NO case for "bridge/background" and reads msg.url directly.
      // Convert from bridge format (args array) to flat direct message format.
      if (method) {
        // httpRequest(url, config) → margs = ["https://...", {method, headers, ...}]
        // other methods → margs = [config] where config may include url
        // Build direct message matching the background switch handler's expected format.
        // httpRequest handler reads: let {uri, options} = e.body
        //   → body.uri    = URL string
        //   → body.options = Axios config (method, headers, data, params, …)
        // Other handlers read e.body or e directly — pass args[0] as body fallback.
        var directMsg;
        if (method === 'httpRequest') {
          if (typeof margs[0] === 'string') {
            directMsg = { name: method, body: { uri: margs[0], options: margs[1] || {} } };
          } else if (margs[0] && margs[0].uri) {
            directMsg = { name: method, body: margs[0] };
          } else {
            directMsg = { name: method, body: { uri: (margs[0] && margs[0].url) || '', options: margs[0] || {} } };
          }
        } else {
          // Generic: pass first arg as body (most handlers read e.body)
          directMsg = { name: method, body: margs[0] };
        }

        // Deliver locally; bridge proxy expects {success, data} but handlers
        // send {status:"success", data} — transform the response on the way out.
        var cbBridge = typeof args[1] === 'function' ? args[1] : null;
        var pBridge  = _deliverLocal(directMsg).then(function (r) {
          if (!r) return { success: false, error: 'No response from handler' };
          if (r.status === 'success') return { success: true,  data:  r.data };
          if (r.status === 'error')   return { success: false, error: r.message || r.error };
          if ('success' in r)         return r;           // already in bridge format
          return { success: true, data: r };              // raw value → wrap
        });
        if (cbBridge) {
          pBridge.then(function (r) { cbBridge(r); }).catch(function () { cbBridge(undefined); });
        }
        return pBridge;
      }
    }

    // For any other named message originating from background, deliver locally.
    // (Firefox background.scripts cannot receive their own sendMessage calls.)
    if (msg && msg.name) {
      var cb = typeof args[1] === 'function' ? args[1] : null;
      var p  = _deliverLocal(msg);
      if (cb) {
        p.then(function (r) { cb(r); }).catch(function () { cb(undefined); });
      }
      return p;
    }

    return _orig.apply(chrome.runtime, args);
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// 10. Auto-inject x-csrf-token into background XHR requests
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var _origOpen      = XMLHttpRequest.prototype.open;
  var _origSend      = XMLHttpRequest.prototype.send;
  var _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._ffUrl     = (typeof url === 'string') ? url : '';
    this._ffHasCsrf = false;
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (typeof name === 'string' && name.toLowerCase() === 'x-csrf-token') {
      if (value) {
        this._ffHasCsrf = true;
      } else {
        // Block empty x-csrf-token header (stream client sends "")
        // The real token will be injected by the send() patch
        return;
      }
    }
    return _origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var url = xhr._ffUrl || '';
    if (!xhr._ffHasCsrf && /https?:\/\/[^/]*yuque\.com/.test(url)) {
      chrome.cookies.get({ url: 'https://www.yuque.com', name: 'yuque_ctoken' }, function (c) {
        if (c && c.value) {
          try { _origSetHeader.call(xhr, 'x-csrf-token', c.value); } catch (e) {}
        }
        _origSend.call(xhr, body);
      });
      return;
    }
    return _origSend.call(this, body);
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// 10b. Auto-inject x-csrf-token into background FETCH requests
//
//      The compiled Axios client uses adapter:"fetch", so XHR patching alone
//      is not enough.  POST/PUT/DELETE requests to yuque.com need an
//      x-csrf-token header whose value matches the yuque_ctoken cookie.
//      Without it the server returns 403 Forbidden.
//
//      Fix: wrap globalThis.fetch so that any non-GET request to *.yuque.com
//      that lacks x-csrf-token gets the token read from chrome.cookies.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  if (typeof globalThis.fetch !== 'function') return;
  var _origFetch = globalThis.fetch;

  globalThis.fetch = function (resource, init) {
    // Axios fetch adapter calls fetch(new Request(...)) with a SINGLE argument.
    // Detect whether resource is a Request object vs a plain URL string.
    var isRequest = (typeof resource === 'object' && resource !== null && typeof resource.url === 'string' && typeof resource.method === 'string');
    var url = '';
    if (typeof resource === 'string') url = resource;
    else if (resource && typeof resource.url === 'string') url = resource.url;

    // Read method from Request object when init is absent
    var method = 'GET';
    if (init && init.method) {
      method = init.method.toUpperCase();
    } else if (isRequest) {
      method = resource.method.toUpperCase();
    }

    // Only intercept non-GET requests to yuque.com
    if (method === 'GET' || !/https?:\/\/[^/]*yuque\.com/.test(url)) {
      return _origFetch.apply(this, arguments);
    }

    // Check if x-csrf-token is already set (check both init.headers and Request.headers)
    var hasCsrf = false;
    if (isRequest && resource.headers) {
      try {
        var val = resource.headers.get('x-csrf-token');
        if (val && val !== '') hasCsrf = true;
      } catch (e) {}
    }
    if (!hasCsrf && init && init.headers) {
      var headers = init.headers;
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        hasCsrf = headers.has('x-csrf-token') && headers.get('x-csrf-token') !== '';
      } else if (Array.isArray(headers)) {
        for (var i = 0; i < headers.length; i++) {
          if (headers[i][0] && headers[i][0].toLowerCase() === 'x-csrf-token' && headers[i][1]) {
            hasCsrf = true; break;
          }
        }
      } else if (typeof headers === 'object') {
        for (var key in headers) {
          if (key.toLowerCase() === 'x-csrf-token' && headers[key]) {
            hasCsrf = true; break;
          }
        }
      }
    }

    if (hasCsrf) {
      return _origFetch.apply(this, arguments);
    }

    // Read the csrf token from the cookie and inject it
    var self = this;
    return new Promise(function (resolve, reject) {
      chrome.cookies.get({ url: 'https://www.yuque.com', name: 'yuque_ctoken' }, function (c) {
        try {
          if (c && c.value) {
            if (isRequest && !init) {
              // Axios pattern: fetch(Request) — clone the Request with new headers
              var newHeaders = new Headers(resource.headers);
              newHeaders.set('x-csrf-token', c.value);
              var newRequest = new Request(resource, { headers: newHeaders });
              resolve(_origFetch.call(globalThis, newRequest));
            } else {
              // Standard pattern: fetch(url, init)
              var newInit = Object.assign({}, init);
              if (!newInit.headers || typeof newInit.headers === 'object' && !(newInit.headers instanceof Headers)) {
                newInit.headers = Object.assign({}, newInit.headers || {});
                newInit.headers['x-csrf-token'] = c.value;
              } else if (newInit.headers instanceof Headers) {
                newInit.headers = new Headers(newInit.headers);
                newInit.headers.set('x-csrf-token', c.value);
              }
              resolve(_origFetch.call(globalThis, resource, newInit));
            }
          } else {
            resolve(_origFetch.apply(self, arguments));
          }
        } catch (e) {
          resolve(_origFetch.apply(self, arguments));
        }
      });
    });
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// 11. bridge/document onMessage – DocumentAPI for external callers
// ─────────────────────────────────────────────────────────────────────────────
var _DOCUMENT_API_METHODS = ['getDocument', 'querySelector', 'querySelectorAll', 'evaluateXPath'];
var _CHROME_API_METHODS   = ['getCookie', 'getAllCookies', 'getCurrentTab', 'navigateTo',
                              'getYuqueRequestConfig', 'yuqueLogin', 'invoke'];

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.name !== 'bridge/document') return false;
  var method = message.body && message.body.method;
  var margs  = (message.body && message.body.args) || [];
  if (_DOCUMENT_API_METHODS.indexOf(method) === -1) return false;
  _handleDocumentApiMethod(method, margs)
    .then(function (r) { sendResponse({ success: true,  data: r }); })
    .catch(function (e) { sendResponse({ success: false, error: (e && e.message) || String(e) }); });
  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. bridge/background onMessage – routes bridge requests from sidebar/content scripts
//
//     The sidebar (and content scripts when using chromeApi) send messages with
//     name:"bridge/background" to the background.  The compiled background switch
//     only handles specific message names (clip, httpRequest, etc.) — it has no
//     case for "bridge/background".  This listener intercepts those messages and:
//       • For ChromeAPI/DocumentAPI methods: calls our built-in implementations.
//       • For httpRequest and other compiled handlers: converts to direct format
//         {name, body:{uri,options}} and dispatches via _deliverLocal.
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.name !== 'bridge/background') return false;
  var method = message.body && message.body.method;
  var margs  = (message.body && message.body.args) || [];
  if (!method) return false;

  var isDoc = _DOCUMENT_API_METHODS.indexOf(method) !== -1;
  var isChr = _CHROME_API_METHODS.indexOf(method) !== -1;

  if (isDoc || isChr) {
    var handler = isDoc ? _handleDocumentApiMethod : _handleChromeApiMethod;
    handler(method, margs)
      .then(function (r) { sendResponse({ success: true,  data:  r }); })
      .catch(function (e) { sendResponse({ success: false, error: (e && e.message) || String(e) }); });
    return true;
  }

  // For all other methods, convert to direct message format and deliver locally.
  var directMsg;
  if (method === 'httpRequest') {
    var _uri  = typeof margs[0] === 'string' ? margs[0] : ((margs[0] && margs[0].url) || '');
    var _opts = typeof margs[0] === 'string' ? (margs[1] || {}) : (margs[0] || {});
    directMsg = { name: method, body: { uri: _uri, options: _opts } };
  } else {
    directMsg = { name: method, body: margs[0] };
  }

  if (!_deliverLocal) { sendResponse({ success: false, error: '_deliverLocal not ready' }); return true; }

  _deliverLocal(directMsg)
    .then(function (r) {
      if (!r)                  { sendResponse({ success: false, error: 'No response' }); return; }
      if (r.status === 'success') sendResponse({ success: true,  data:  r.data });
      else if (r.status === 'error') sendResponse({ success: false, error: r.message || r.error });
      else if ('success' in r) sendResponse(r);
      else                     sendResponse({ success: true, data: r });
    })
    .catch(function (e) { sendResponse({ success: false, error: String(e) }); });
  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
// 12b. Fix: screenshot "removeCut" missing response
//
//      The compiled handler for screenshot "removeCut" calls executeScript but
//      never sends a response, causing Firefox's "Promised response went out of
//      scope" error. Fix: intercept removeCut and send a proper response.
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.name) return false;

  // ── Fix for removeCut: handle it and send response ──
  if (message.name === 'screenshot' && message.body && message.body.action === 'removeCut') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) { sendResponse({ status: 'ok' }); return; }
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () {
          if (window.content_app && typeof window.content_app.destroyScreenShot === 'function') {
            window.content_app.destroyScreenShot();
          }
        },
      }).then(function () {
        sendResponse({ status: 'ok' });
      }).catch(function () {
        sendResponse({ status: 'ok' });
      });
    }).catch(function () {
      sendResponse({ status: 'ok' });
    });
    return true; // keep channel open for async response
  }

  return false;  // Don't handle — let the compiled handler process it
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. chrome.commands.onCommand.addListener – inject active Tab as 2nd arg
//
//     In Firefox, commands.onCommand listener receives only (command: string).
//     In Chrome/Edge it receives (command: string, tab: Tab).
//     The compiled App.onCommandListener does:
//       async onCommandListener(e, t) { ... tabId: t.id ... sendMessage(t.id, ...) }
//     With t === undefined this throws TypeError before the try/catch, silently
//     breaking ALL keyboard shortcut features (selectArea, startOcr, clipPage).
//
//     Fix: wrap addListener so every registered listener is called as
//       listener(command, activeTab)  with the current active tab injected.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var _origAddCmdListener = chrome.commands.onCommand.addListener.bind(chrome.commands.onCommand);
  chrome.commands.onCommand.addListener = function (listener) {
    return _origAddCmdListener(function (command) {
      // Query the active tab and inject it as the second argument
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        try {
          listener(command, tab);
        } catch (e) {
          console.warn('[FF polyfill] onCommand listener threw:', e);
        }
      });
    });
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// 13. open_sidepanel command handler
// ─────────────────────────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(function (command) {
  if (command === 'open_sidepanel' &&
      typeof browser !== 'undefined' && browser.sidebarAction) {
    browser.sidebarAction.open().catch(function (e) {
      console.warn('[FF polyfill] sidebarAction.open (command) failed:', e);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// API implementations
// ═════════════════════════════════════════════════════════════════════════════

// ─── DocumentAPI ─────────────────────────────────────────────────────────────
async function _handleDocumentApiMethod(method, args) {
  switch (method) {
    case 'getDocument': {
      var resp = await fetch(args[0]);
      var html = await resp.text();
      var doc  = new DOMParser().parseFromString(html, 'text/html');
      return doc.documentElement ? doc.documentElement.outerHTML : html;
    }
    case 'querySelector': {
      if (!args[1]) return null;
      var doc = new DOMParser().parseFromString(args[1], 'text/html');
      var el  = doc.querySelector(args[0]);
      return el ? el.outerHTML : null;
    }
    case 'querySelectorAll': {
      if (!args[1]) return [];
      var doc = new DOMParser().parseFromString(args[1], 'text/html');
      return Array.from(doc.querySelectorAll(args[0])).map(function (el) { return el.outerHTML; });
    }
    case 'evaluateXPath': {
      if (!args[1]) return [];
      var doc = new DOMParser().parseFromString(args[1], 'text/html');
      try {
        var xe  = new XPathEvaluator();
        var res = xe.evaluate(args[0], doc.documentElement, null, XPathResult.ANY_TYPE, null);
        var nodes = [], node = res.iterateNext();
        while (node) {
          nodes.push(node instanceof Element ? node.outerHTML : node.textContent);
          node = res.iterateNext();
        }
        return nodes;
      } catch (e) { console.warn('[FF polyfill] XPath failed:', e); return []; }
    }
    default:
      throw new Error('[FF polyfill] Unknown DocumentAPI method: ' + method);
  }
}

// ─── ChromeAPI ───────────────────────────────────────────────────────────────
async function _handleChromeApiMethod(method, args) {

  // Read the yuque host from Plasmo storage (stored as JSON.stringify'd string)
  function _getYuqueHost() {
    return new Promise(function (resolve) {
      chrome.storage.local.get('debug/env', function (result) {
        try {
          var envMap = {
            prod: 'https://www.yuque.com',
            pre:  'https://yuquepre.yuque.com',
            test: 'https://yuquetest-2.yuque.com',
          };
          var raw = result && result['debug/env'];
          if (raw) { resolve(envMap[JSON.parse(raw)] || 'https://www.yuque.com'); return; }
        } catch (e) { /* fall through */ }
        resolve('https://www.yuque.com');
      });
    });
  }

  // Callback-safe cookie reader
  function _getCookieRaw(url, name) {
    return new Promise(function (resolve, reject) {
      chrome.cookies.get({ url: url, name: name }, function (c) {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(c);
      });
    });
  }

  switch (method) {

    case 'getCookie':
      return _getCookieRaw(args[0], args[1]);

    case 'getAllCookies': {
      var details = Object.assign({}, args[0]);
      delete details.partitionKey;
      return new Promise(function (resolve, reject) {
        chrome.cookies.getAll(details, function (cookies) {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(cookies);
        });
      });
    }

    case 'getCurrentTab':
      return new Promise(function (resolve, reject) {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(tabs[0]);
        });
      });

    case 'navigateTo':
      return new Promise(function (resolve, reject) {
        chrome.tabs.create({ url: args[0] }, function (tab) {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(tab);
        });
      });

    case 'getYuqueRequestConfig': {
      var host = await _getYuqueHost();
      var c1   = await _getCookieRaw(host, '_yuque_session').catch(function () { return null; });
      var c2   = await _getCookieRaw(host, 'yuque_ctoken').catch(function () { return null; });
      var cookieStr = [c1, c2].filter(Boolean)
        .map(function (c) { return c.name + '=' + c.value; }).join('; ');
      return { cookie: cookieStr, csrf: c2 ? c2.value : null };
    }

    // ── yuqueLogin  ──────────────────────────────────────────────────────────
    // Three-layer detection strategy:
    //   1. cookies.onChanged: fires when _yuque_session is set → most reliable
    //   2. webRequest.onCompleted: catches /api/mine, /dashboard, etc.
    //   3. tabs.onRemoved: cleanup if user closes the tab manually
    //
    // After detection:
    //   a) Immediately resolve the bridge promise (prevents channel timeout)
    //   b) Call _fetchAndStoreUserInfo() independently to write user data to
    //      chrome.storage.local → sidebar's storage.onChanged watcher fires
    //      and navigates to the main page even if updateUserInfo() in the
    //      sidebar itself fails.
    // ─────────────────────────────────────────────────────────────────────────
    case 'yuqueLogin': {
      var loginHost = await _getYuqueHost();

      return new Promise(function (resolve) {
        chrome.tabs.create({ url: loginHost + '/login' }, function (tab) {
          if (chrome.runtime.lastError || !tab) {
            console.warn('[FF polyfill] Could not create login tab');
            resolve(null);
            return;
          }

          var tabId    = tab.id;
          var detected = false;

          function onLoginDetected() {
            if (detected) return;
            detected = true;
            cleanup();
            chrome.tabs.remove(tabId, function () {});

            // Resolve immediately so the bridge message channel doesn't time out.
            // The sidebar will navigate via storage.onChanged when user data lands.
            _handleChromeApiMethod('getYuqueRequestConfig', [])
              .then(function (cfg) { resolve(cfg); })
              .catch(function ()   { resolve(null); });

            // Independently fetch user info and write to storage.
            // This is the reliable path: sidebar watches storage.onChanged for
            // "common/user" and updates the UI regardless of bridge state.
            setTimeout(function () {
              _fetchAndStoreUserInfo(loginHost);
            }, 300);
          }

          // Listener 1: cookie-based (most reliable – fires when session is set)
          var cookieListener = function (changeInfo) {
            if (!changeInfo.removed &&
                changeInfo.cookie.name === '_yuque_session' &&
                changeInfo.cookie.domain.includes('yuque.com')) {
              // Small delay to let yuque_ctoken cookie also be set
              setTimeout(onLoginDetected, 400);
            }
          };
          chrome.cookies.onChanged.addListener(cookieListener);

          // Listener 2: webRequest-based (fallback – catches dashboard/api/mine)
          var webReqListener = function (details) {
            if (details.statusCode === 200 &&
                /\/api\/mine|\/dashboard|\/home|\/writing/.test(details.url)) {
              onLoginDetected();
            }
          };
          chrome.webRequest.onCompleted.addListener(
            webReqListener,
            { urls: ['<all_urls>'], tabId: tabId }
          );

          // Listener 3: tab removed → user cancelled login
          var tabRemovedListener = function (removedTabId) {
            if (removedTabId === tabId) {
              detected = true;
              cleanup();
              resolve(null);
            }
          };
          chrome.tabs.onRemoved.addListener(tabRemovedListener);

          function cleanup() {
            chrome.cookies.onChanged.removeListener(cookieListener);
            chrome.webRequest.onCompleted.removeListener(webReqListener);
            chrome.tabs.onRemoved.removeListener(tabRemovedListener);
          }
        });
      });
    }

    case 'invoke': {
      var apiPath    = args[0];
      var methodName = args[1];
      var extraArgs  = args.slice(2);
      var parts      = apiPath.split('.');
      var obj        = chrome;
      for (var i = 0; i < parts.length; i++) {
        obj = obj[parts[i]];
        if (!obj) throw new Error('[FF polyfill] API path not found: ' + apiPath);
      }
      var fn = obj[methodName];
      if (typeof fn !== 'function') {
        throw new Error('[FF polyfill] Method not found: ' + methodName + ' in ' + apiPath);
      }
      return new Promise(function (resolve, reject) {
        fn.apply(obj, extraArgs.concat([function (result) {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(result);
        }]));
      });
    }

    default:
      throw new Error('[FF polyfill] Unknown ChromeAPI method: ' + method);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// _fetchAndStoreUserInfo
//
// Called after login is detected. Independently fetches /api/mine with the
// session cookie (read via chrome.cookies.get, set as an explicit header —
// Firefox extensions are allowed to set the Cookie header for permitted hosts)
// and writes the user object into chrome.storage.local using Plasmo's format:
//   key:   "common/user"
//   value: JSON.stringify({ userId, userName, avatar, logonId })
//
// The sidebar's Plasmo storage.onChanged watcher detects this write and
// navigates the React app to the main (note-editing) page.
// ─────────────────────────────────────────────────────────────────────────────
async function _fetchAndStoreUserInfo(host) {
  try {
    // Wait a moment for cookies to be fully committed
    await new Promise(function (r) { setTimeout(r, 200); });

    // Read session cookies
    var session = await new Promise(function (resolve, reject) {
      chrome.cookies.get({ url: host, name: '_yuque_session' }, function (c) {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(c);
      });
    });

    if (!session || !session.value) {
      console.warn('[FF polyfill] _yuque_session cookie not found, retrying in 1s…');
      await new Promise(function (r) { setTimeout(r, 1000); });
      session = await new Promise(function (resolve) {
        chrome.cookies.get({ url: host, name: '_yuque_session' }, function (c) {
          resolve(chrome.runtime.lastError ? null : c);
        });
      });
      if (!session || !session.value) {
        console.warn('[FF polyfill] _yuque_session still missing after retry');
        return;
      }
    }

    var ctoken = await new Promise(function (resolve) {
      chrome.cookies.get({ url: host, name: 'yuque_ctoken' }, function (c) { resolve(c); });
    });

    var cookieStr = '_yuque_session=' + session.value +
                    (ctoken ? '; yuque_ctoken=' + ctoken.value : '');

    // Build extension-id: extract UUID from getURL using the same logic the client uses
    var extId = chrome.runtime.getURL('').replace('chrome-extension://', '').replace('/', '');

    var response = await fetch(host + '/api/mine', {
      method: 'GET',
      credentials: 'include',   // also include cookies automatically
      headers: {
        // Firefox extensions may set Cookie for host_permissions hosts
        'Cookie':                           cookieStr,
        'extension-id':                     extId,
        'x-yuque-chrome-extension-version': chrome.runtime.getManifest().version,
        'x-extension-type':                 'yuque',
        'content-type':                     'application/json',
      },
    });

    if (!response.ok) {
      console.warn('[FF polyfill] /api/mine returned', response.status);
      return;
    }

    var json = await response.json();
    var data = json && json.data;
    if (!data) { console.warn('[FF polyfill] /api/mine empty data'); return; }

    var userInfo = {
      userId:   data.account && data.account.id,
      userName: data.name,
      avatar:   data.avatar_url,
      logonId:  data.login,
    };

    if (!userInfo.userId) {
      console.warn('[FF polyfill] /api/mine: userId missing in response');
      return;
    }

    // Write in Plasmo storage format: value = JSON.stringify(userInfo)
    await new Promise(function (resolve) {
      chrome.storage.local.set({ 'common/user': JSON.stringify(userInfo) }, resolve);
    });

  } catch (e) {
    console.error('[FF polyfill] _fetchAndStoreUserInfo failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 15: API Proxy for iframe context (web-accessible resource pages)
//
// When tabs/sandbox.html is loaded inside an iframe on a web page (the floating
// overlay), Firefox treats it as a web-accessible resource page.  These pages
// do NOT have access to privileged extension APIs (chrome.tabs, chrome.scripting,
// etc.). Only runtime.sendMessage/connect/getURL are available.
//
// The sidebar polyfill (loaded in the iframe) creates shims for missing APIs
// that delegate to the background via runtime.sendMessage with special names.
// This section handles those delegated requests using the background's full
// extension privileges.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.name) return false;

    // ── chrome.tabs.query proxy ──
    if (message.name === '__FF_TABS_QUERY__') {
      chrome.tabs.query(message.body || {}).then(function (tabs) {
        sendResponse({ success: true, data: tabs });
      }).catch(function (err) {
        sendResponse({ success: false, error: err && err.message });
      });
      return true; // keep channel open for async response
    }

    // ── chrome.tabs.sendMessage proxy ──
    if (message.name === '__FF_TABS_SEND_MESSAGE__') {
      var tabId = message.body && message.body.tabId;
      var msg   = message.body && message.body.message;
      chrome.tabs.sendMessage(tabId, msg).then(function (resp) {
        sendResponse({ success: true, data: resp });
      }).catch(function (err) {
        // sendMessage to tab may fail (e.g. no listener), treat as non-fatal
        sendResponse({ success: true, data: undefined });
      });
      return true;
    }

    // ── chrome.tabs.get proxy ──
    if (message.name === '__FF_TABS_GET__') {
      var tid = message.body && message.body.tabId;
      chrome.tabs.get(tid).then(function (tab) {
        sendResponse({ success: true, data: tab });
      }).catch(function (err) {
        sendResponse({ success: false, error: err && err.message });
      });
      return true;
    }

    // ── chrome.tabs.create proxy ──
    if (message.name === '__FF_TABS_CREATE__') {
      chrome.tabs.create(message.body || {}).then(function (tab) {
        sendResponse({ success: true, data: tab });
      }).catch(function (err) {
        sendResponse({ success: false, error: err && err.message });
      });
      return true;
    }

    // ── chrome.tabs.update proxy ──
    if (message.name === '__FF_TABS_UPDATE__') {
      var utid = message.body && message.body.tabId;
      var uprops = message.body && message.body.updateProperties;
      chrome.tabs.update(utid, uprops || {}).then(function (tab) {
        sendResponse({ success: true, data: tab });
      }).catch(function (err) {
        sendResponse({ success: false, error: err && err.message });
      });
      return true;
    }

    // ── chrome.tabs.remove proxy ──
    if (message.name === '__FF_TABS_REMOVE__') {
      var rtids = message.body && message.body.tabIds;
      chrome.tabs.remove(rtids).then(function () {
        sendResponse({ success: true, data: undefined });
      }).catch(function (err) {
        sendResponse({ success: false, error: err && err.message });
      });
      return true;
    }

    return false; // not handled
  });

})();
