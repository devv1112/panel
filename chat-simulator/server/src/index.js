/**
 * @file Process entry point. Reads real environment variables, builds the
 * upstream adapter and starts the local HTTP server.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { CoarenaClient } from "./coarena-client.js";
import { loadConfig, withStaticDir } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

try {
    const envConfig = loadConfig();
    const staticDir = process.env.APP_STATIC_DIR?.trim()
        ? path.resolve(process.env.APP_STATIC_DIR)
        : path.resolve(here, "../../web/dist");
    const config = withStaticDir(envConfig, staticDir);
    const client = new CoarenaClient(config);
    const server = createApp(config, client);

    server.listen(config.port, config.host, () => {
        console.log(`[chat-simulator] listening on http://${config.host}:${config.port}`);
        console.log(`[chat-simulator] upstream base: ${config.baseUrl.href}`);
        console.log(`[chat-simulator] model ids are loaded live from GET ${config.baseUrl.href}models`);
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => server.close(() => process.exit(0)));
    }
} catch (error) {
    console.error(`[chat-simulator] startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
