// External browser-target diagnostic: no page scripts or graphics settings change.
export async function captureBrowserGpuInfo(address, {
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
  timeoutMs = 3000,
} = {}) {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(address ?? ''))
    throw new Error('Missing loopback Chrome debugger address');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('GPU info deadline expired')), timeoutMs);
  let socket;
  try {
    const response = await fetchImpl(`http://${address}/json/version`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Chrome version endpoint: ${response.status}`);
    const { webSocketDebuggerUrl } = await response.json();
    const endpoint = new URL(webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' ||
        !['localhost', '127.0.0.1'].includes(endpoint.hostname) ||
        endpoint.port !== address.split(':')[1] ||
        !endpoint.pathname.startsWith('/devtools/browser/'))
      throw new Error('Unexpected browser debugger endpoint');
    controller.signal.throwIfAborted();
    socket = new WebSocketImpl(endpoint.href);
    return await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        controller.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(result);
      };
      const aborted = () => finish(controller.signal.reason);
      controller.signal.addEventListener('abort', aborted, { once: true });
      socket.addEventListener('open', () => {
        try { socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' })); }
        catch (error) { finish(error); }
      });
      socket.addEventListener('message', ({ data }) => {
        try {
          const message = JSON.parse(String(data));
          if (message.id !== 1) return;
          if (message.error) throw new Error(JSON.stringify(message.error));
          const { gpu, modelName, modelVersion } = message.result;
          finish(null, { gpu, modelName, modelVersion });
        } catch (error) { finish(error); }
      });
      socket.addEventListener('error', () => finish(new Error('Browser debugger socket failed')));
      socket.addEventListener('close', () => finish(new Error('Browser debugger closed before GPU response')));
    });
  } finally {
    clearTimeout(timer);
    try { socket?.close(); } catch { /* A failed connection may already be closed. */ }
  }
}
