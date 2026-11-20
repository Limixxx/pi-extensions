## pi-app-server
pi install npm:pi-app-server
npx pi-server serve --port 3141 --provider maas --model GLM-5.3
npx pi-server serve --port 3141
PI_VERSION=$(cat /root/.pi/agent/install/current-version)
npx pi-server serve --port 3141 --pi-cli-path ~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-workspce/pi-coding-agent/dist/bundle/cli.js

## pi-channels
集成到了PI框架中，通过settings.json配置。
pi install npm:@amaster.ai/pi-channels