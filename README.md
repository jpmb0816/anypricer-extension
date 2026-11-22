# Script Injector

A Chrome extension that runs your team's page scripts automatically, with on/off controls per script and per site,
reinjection, error reports and a dashboard.

## Install (Windows)

1. Download **[ScriptInjector-Setup.exe](https://github.com/jpmb0816/anypricer-extension/releases/latest/download/ScriptInjector-Setup.exe)**
   and run it. Windows may show "Windows protected your PC": click **More info → Run anyway**.
2. Paste the **team code** you received from your team admin (it starts with `SI1.`).
3. Click **Install**. When it finishes, Chrome opens its extensions page:
   1. Turn on **Developer mode** (top right).
   2. Click **Load unpacked**, paste the folder path (already copied, press **Ctrl+V**), press **Enter**, then **Select Folder**.
   3. Open the extension's **Details** and turn on **Allow User Scripts**.

That's it. The scripts load from your team automatically.

## Using it

- Click the extension icon for the popup: what runs on the current page, pause a site, reinject, open the dashboard.
- The page scripts start in **Lite mode** (only the essentials). The **Lite: on / off** button at the bottom-left of the
  page switches to the full view. Tools and filters open with the small **⚙ Tools & filters** button.

## Updates

Updates install themselves (the setup checks every 6 hours by default). When a new version is ready, the extension
switches to it while no team page is open, or the next time Chrome starts. The popup shows what changed.

- Update now: Start menu → **Update Script Injector**.
- Turn automatic updates off / on: Start menu → **Script Injector auto-update OFF / ON**.
- Extension settings → Updates: how often to check, and whether to apply updates automatically.

## Uninstall

Windows **Settings → Apps → Installed apps → Script Injector → Uninstall** (or Start menu → **Uninstall Script Injector**).
Then remove it from Chrome: open `chrome://extensions` and click **Remove** on its card.

## Privacy

The extension only talks to the services your team set up (your team's script library and sync). The team code is
stored on your computer only.
