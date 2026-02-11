import { ClientRequest, ClientRequestSchema, PROTOCOL_VERSION, ServerEvent, ServerResponse } from '../../../shared/schema';

type Handler = (payload: any) => void;
type StatusHandler = (status: { connected: boolean; error?: string }) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private statusHandlers = new Set<StatusHandler>();

  private emitStatus(status: { connected: boolean; error?: string }) {
    this.statusHandlers.forEach((h) => h(status));
  }

  connect(url: string) {
    if (this.ws) this.ws.close();
    this.ws = new WebSocket(url);

    this.emitStatus({ connected: false });
    this.ws.onopen = () => {
      this.emitStatus({ connected: true });
    };
    this.ws.onclose = () => {
      this.emitStatus({ connected: false });
      this.pending.forEach((p) => p.reject(new Error('WS closed')));
      this.pending.clear();
    };
    this.ws.onerror = () => {
      this.emitStatus({ connected: false, error: 'WS error' });
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if ((data as ServerResponse).type === 'server_response' && data.id) {
        const pending = this.pending.get(data.id);
        if (pending) {
          if ((data as ServerResponse).ok) pending.resolve((data as ServerResponse).result);
          else pending.reject((data as ServerResponse).error);
          this.pending.delete(data.id);
        }
        return;
      }

      if ((data as ServerEvent).type === 'server_event') {
        const handlers = this.handlers.get((data as ServerEvent).event) || [];
        handlers.forEach((h) => h((data as ServerEvent).payload));
      }
    };
  }

  on(event: ServerEvent['event'], handler: Handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const current = this.handlers.get(event) || [];
      this.handlers.set(
        event,
        current.filter((candidate) => candidate !== handler)
      );
    };
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  request(command: string, args?: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WS not connected'));
    }

    const message: ClientRequest = {
      version: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: 'client_request',
      command,
      args,
      meta: { ts: Date.now() },
    };

    ClientRequestSchema.parse(message);

    this.ws.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
    });
  }
}
