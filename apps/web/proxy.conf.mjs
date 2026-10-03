import { env } from "node:process";
import defaults from "../../george.defaults.json" with { type: "json" };

const port = env["GEORGE_HOST_PORT"] ?? String(defaults.host.port);

export default {
  "/api/**": {
    target: `http://127.0.0.1:${port}`,
    secure: false,
    changeOrigin: false
  }
};
