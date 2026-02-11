import { WsClient } from './wsClient';

export const v2Client = new WsClient();

export function connectV2Client(url = 'ws://localhost:3011') {
  try {
    v2Client.connect(url);
  } catch {
    // best-effort; UI will still work with mock
  }
}

