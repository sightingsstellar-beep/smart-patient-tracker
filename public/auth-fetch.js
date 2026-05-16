/* global window, document */
(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  let statusPromise = null;
  let clerkReadyPromise = null;

  function sameOriginApi(input) {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
      return url.origin === window.location.origin
        && url.pathname.startsWith('/api/')
        && url.pathname !== '/api/auth/status';
    } catch (_) {
      return false;
    }
  }

  function requestMethod(input, options = {}) {
    return String(options.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  }

  async function getAuthStatus() {
    if (!statusPromise) {
      statusPromise = nativeFetch('/api/auth/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    }
    return statusPromise;
  }

  function injectClerkScript(src, publishableKey) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-glide-clerk="true"], script[data-clerk-publishable-key]');
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        if (window.Clerk) resolve();
        return;
      }
      const script = document.createElement('script');
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.dataset.glideClerk = 'true';
      script.dataset.clerkPublishableKey = publishableKey;
      script.src = src;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('Clerk browser library failed to load.')), { once: true });
      document.head.appendChild(script);
    });
  }

  async function ensureClerk() {
    const status = await getAuthStatus();
    if (!status?.clerkEnabled || !status?.clerkConfigured || !status?.clerkPublishableKey || !status?.clerkScriptSrc) {
      return null;
    }
    if (!clerkReadyPromise) {
      clerkReadyPromise = (async () => {
        if (!window.Clerk) {
          await injectClerkScript(status.clerkScriptSrc, status.clerkPublishableKey);
        }
        if (!window.Clerk) return null;
        if (!window.Clerk.loaded) {
          await window.Clerk.load({ publishableKey: status.clerkPublishableKey });
        }
        return window.Clerk;
      })().catch((err) => {
        console.warn('[auth] Clerk token helper unavailable:', err.message);
        return null;
      });
    }
    return clerkReadyPromise;
  }

  async function getClerkToken({ skipCache = false } = {}) {
    const clerk = await ensureClerk();
    if (!clerk?.session?.getToken) return null;
    try {
      return await clerk.session.getToken({ skipCache });
    } catch (err) {
      console.warn('[auth] Clerk token refresh failed:', err.message);
      return null;
    }
  }

  async function fetchWithFreshAuth(input, options = {}) {
    const method = requestMethod(input, options);
    const headers = new Headers(options.headers || (typeof input !== 'string' ? input.headers : undefined));
    const shouldAuth = sameOriginApi(input) && !headers.has('Authorization');
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);

    // Authenticated GETs are already covered by Clerk's same-origin session
    // cookies on the server. Avoid loading Clerk's browser bundle just to render
    // ordinary page data; reserve token work for writes and 401 recovery.
    if (shouldAuth && write) {
      const token = await getClerkToken({ skipCache: true });
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }

    const request = {
      ...options,
      headers,
      credentials: options.credentials || 'same-origin',
    };

    let res = await nativeFetch(input, request);
    if (res.status !== 401 || !shouldAuth) return res;

    const token = await getClerkToken({ skipCache: true });
    if (!token) return res;
    headers.set('Authorization', `Bearer ${token}`);
    res = await nativeFetch(input, { ...request, headers });
    return res;
  }

  window.GlideAuth = {
    fetch: fetchWithFreshAuth,
    getToken: getClerkToken,
    ensureClerk,
  };
  window.fetch = fetchWithFreshAuth;
})();
