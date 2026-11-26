import { createServer } from "node:http";
import {
  createEgressGateway,
  createEgressPolicy,
} from "../../packages/components/security/src/egress.ts";
import { green, red } from "./common.mjs";

const EVIDENCE =
  "packages/components/security/src/egress.ts:121-127（当前只校验首跳后把 input/init 直接交给底层 fetch，自动跟随 30x）";

export default {
  id: "RED-08-egress-redirect-hop",
  title: "30x 重定向必须逐跳重验 egress，跨 origin 不得携带凭证",
  expectation:
    "首跳放行后返回 30x 指向未放行的 localhost，网关必须在第二跳 fetch 之前拒绝（EGRESS_DENIED），夹具的 /denied 端点不得被触达",
  target: "AC-11",
  async probe() {
    const hits = [];
    const server = createServer((request, response) => {
      hits.push({ url: request.url, authorization: request.headers.authorization ?? null, apiKey: request.headers["x-api-key"] ?? null });
      if (request.url === "/start") {
        response.writeHead(302, {
          location: `http://localhost:${server.address().port}/denied`,
        });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("reached-second-hop");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    let error = "";
    let status = 0;
    try {
      const gateway = createEgressGateway({
        policy: createEgressPolicy({ allow: [{ host: "127.0.0.1", port }] }),
        fetch: globalThis.fetch,
      });
      const response = await gateway.fetch(`http://127.0.0.1:${port}/start`, {
        method: "GET",
        headers: { authorization: "Bearer probe", "x-api-key": "probe-key" },
      });
      status = response.status;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }

    const secondHop = hits.find((hit) => hit.url === "/denied");
    const actual = { error, status, hits };
    const rejected = error.includes("EGRESS_DENIED");
    return rejected && secondHop === undefined
      ? green(actual, "packages/components/security/src/egress.ts（逐跳 resolve/DNS/policy/enforcer 与跨 origin 去凭证路径）")
      : red(
          actual,
          secondHop !== undefined
            ? `底层 fetch 自动跟随 30x 并触达未放行目标的 /denied（携带 authorization=${secondHop.authorization}、x-api-key=${secondHop.apiKey}）：没有逐跳重验 egress，也没有跨 origin 去凭证`
            : `重定向没有被逐跳门禁拒绝：error=${error || "无"} status=${status}`,
          EVIDENCE
        );
  },
};
