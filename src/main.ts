import { createApplication } from './app.module.js';
import { loadConfig } from './config.js';

try {
  const config = loadConfig();
  const app = await createApplication(config);
  await app.listen(config.port, '127.0.0.1');
  console.log(`P3 demo API listening on 127.0.0.1:${config.port}`);
} catch {
  console.error('P3 startup failed. Check local configuration and port availability; details redacted.');
  process.exitCode = 1;
}
