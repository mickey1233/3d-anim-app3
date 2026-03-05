import { WsClient } from './wsClient';

export const v2Client = new WsClient();

let connectAttemptSeq = 0;
let cleanupConnectStatusListener: (() => void) | null = null;
let connectFallbackTimer: number | null = null;

function clearConnectFallbackState() {
  if (cleanupConnectStatusListener) {
    cleanupConnectStatusListener();
    cleanupConnectStatusListener = null;
  }
  if (connectFallbackTimer != null) {
    window.clearTimeout(connectFallbackTimer);
    connectFallbackTimer = null;
  }
}

function buildCandidateWsUrls(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return [url];
    const hostname = parsed.hostname;
    const isLocalHost =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLocalHost) return [url];

    const hosts = ['127.0.0.1', 'localhost', '::1'];
    const urls: string[] = [];
    for (const host of hosts) {
      const candidate = new URL(url);
      candidate.hostname = host;
      urls.push(candidate.toString());
    }
    return [...new Set(urls)];
  } catch {
    return [url];
  }
}

export function connectV2Client(url = 'ws://localhost:3011') {
  const candidates = buildCandidateWsUrls(url);
  const seq = ++connectAttemptSeq;
  clearConnectFallbackState();

  let candidateIndex = 0;
  let connected = false;

  const tryConnect = () => {
    if (seq !== connectAttemptSeq) return;
    const candidate = candidates[candidateIndex];
    if (!candidate) return;
    connected = false;
    try {
      v2Client.connect(candidate);
    } catch {
      candidateIndex += 1;
      tryConnect();
      return;
    }
    if (connectFallbackTimer != null) window.clearTimeout(connectFallbackTimer);
    connectFallbackTimer = window.setTimeout(() => {
      if (seq !== connectAttemptSeq) return;
      if (connected) return;
      candidateIndex += 1;
      if (candidateIndex < candidates.length) tryConnect();
    }, 800);
  };

  try {
    cleanupConnectStatusListener = v2Client.onStatus((status) => {
      if (seq !== connectAttemptSeq) return;
      if (status.connected) {
        connected = true;
        if (connectFallbackTimer != null) {
          window.clearTimeout(connectFallbackTimer);
          connectFallbackTimer = null;
        }
        return;
      }
      if (!connected && status.error) {
        if (connectFallbackTimer != null) window.clearTimeout(connectFallbackTimer);
        candidateIndex += 1;
        if (candidateIndex < candidates.length) {
          tryConnect();
        }
      }
    });
    tryConnect();
  } catch {
    // best-effort; UI will still work with mock
    clearConnectFallbackState();
  }
}
