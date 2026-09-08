// The only owner of the socket and its reconnect lifetime.
export function createAppTransport({ onMessage, onStatus }) {
  let socket = null;
  let reconnectTimer = null;
  let stopped = true;
  const isOpen = () => socket?.readyState === WebSocket.OPEN;
  function connect() {
    if (stopped) return;
    onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(`${proto}//${location.host}/ws`);
    socket = current;
    current.onopen = () => { if (socket === current) onStatus("open"); };
    current.onmessage = (event) => {
      if (socket !== current) return;
      let message;
      try { message = JSON.parse(event.data); }
      catch (error) { console.error("parse error", error); return; }
      if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
        console.error("parse error", new TypeError("Server frame requires an object with a string type"));
        return;
      }
      onMessage(message);
    };
    current.onclose = () => {
      if (socket !== current || stopped) return;
      socket = null;
      onStatus("closed");
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
    };
    current.onerror = () => { if (socket === current && !stopped) onStatus("error"); };
  }
  return Object.freeze({
    isOpen,
    send(payload) {
      if (!isOpen()) return false;
      socket.send(JSON.stringify(payload));
      return true;
    },
    start() { if (stopped) { stopped = false; connect(); } },
    close() {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = socket;
      socket = null;
      current?.close();
    },
  });
}
