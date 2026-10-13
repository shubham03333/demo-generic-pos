import fs from 'fs';
import path from 'path';
import type { CapacitorConfig } from '@capacitor/cli';

function liveWebsite(): string {
  const fromEnv =
    process.env.CAPACITOR_SERVER_URL?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(process.cwd(), 'capacitor.server.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { url?: string };
    if (parsed.url?.trim()) return parsed.url.trim();
  } catch {
    // file optional
  }
  return 'https://YOUR_PRODUCTION_DOMAIN';
}

/** Live Adda Cafe website the APK should open. Set `url` in capacitor.server.json. */
const LIVE_WEBSITE = liveWebsite();

const liveHost = LIVE_WEBSITE.replace(/^https?:\/\//, '').split('/')[0];
const usingLiveSite = !LIVE_WEBSITE.includes('YOUR_PRODUCTION_DOMAIN');

const config: CapacitorConfig = {
  appId: 'com.addacafe.pos',
  appName: 'Adda Cafe',
  webDir: 'www',
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#b91c1c',
    },
  },
  server: usingLiveSite
    ? {
        url: LIVE_WEBSITE.replace(/\/$/, ''),
        androidScheme: 'https',
        cleartext: LIVE_WEBSITE.startsWith('http://'),
        allowNavigation: [liveHost, `www.${liveHost}`.replace('www.www.', 'www.')],
      }
    : {
        androidScheme: 'https',
      },
};

export default config;
