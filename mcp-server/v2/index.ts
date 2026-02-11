import { WsGatewayV2 } from './wsGateway.js';

const port = Number(process.env.V2_WS_PORT || 3011);
const gateway = new WsGatewayV2(port);
gateway.start();
console.log(`[MCP v2] WS gateway listening on ${port}`);
