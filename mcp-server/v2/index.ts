import 'dotenv/config';
import { WsGatewayV2 } from './wsGateway.js';
import { routeAndExecute } from './router/router.js';

const port = Number(process.env.V2_WS_PORT || 3011);
const host = process.env.V2_WS_HOST || '127.0.0.1';
const gateway = new WsGatewayV2(port, host);
gateway.start();
console.log(`[MCP v2] WS gateway listening on ${host}:${port}`);

if (process.env.ROUTER_WARMUP_ON_BOOT !== '0') {
  setTimeout(() => {
    void routeAndExecute('warmup', {
      parts: [],
      cadFileName: null,
      stepCount: 0,
      currentStepId: null,
      selectionPartId: null,
      interactionMode: 'select',
      toolResults: [],
      iteration: 0,
    }).catch(() => undefined);
  }, 50);
}
