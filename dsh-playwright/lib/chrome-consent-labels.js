// Copyright 2015 The Chromium Authors
// Resource strings derived from Chromium; see assets/chromium-LICENSE.txt.
// Source snapshot: f3363f52a24e8571c9d94339c566e18d3450e633
// https://chromium.googlesource.com/chromium/src/+/f3363f52a24e8571c9d94339c566e18d3450e633/chrome/app/generated_resources.grd
// https://chromium.googlesource.com/chromium/src/+/f3363f52a24e8571c9d94339c566e18d3450e633/chrome/app/resources/
// IDS_DEV_TOOLS_CONNECTION_DIALOG_TITLE (XTB id 1953626242273481999)
// IDS_DEV_TOOLS_CONNECTION_DIALOG_ALLOW_TEXT (XTB id 5039804452771397117)
// Keep titles paired with their own affirmative button, never a global Allow list.
// Chrome's display language selects its labels, not the OS, PW_LANG or Web UI.
export const CHROME_CONSENT_LABELS = Object.freeze(
  [
    { locales: ['en', 'en-US', 'en-GB'], title: 'Allow remote debugging?', allow: 'Allow' },
    { locales: ['zh-CN'], title: '要允许远程调试吗？', allow: '允许' },
    { locales: ['zh-TW', 'zh-HK'], title: '允許遠端偵錯嗎？', allow: '允許' },
    { locales: ['es'], title: '¿Permitir depuración remota?', allow: 'Permitir' },
    { locales: ['es-419'], title: '¿Deseas permitir la depuración remota?', allow: 'Permitir' },
    {
      locales: ['hi'],
      title: 'क्या आपको बाहरी ऐप्लिकेशन के ज़रिए डिबग करने की अनुमति देनी है?',
      allow: 'अनुमति दें',
    },
    { locales: ['ar'], title: 'السماح بتصحيح الأخطاء عن بُعد؟', allow: 'سماح' },
    { locales: ['pt-BR'], title: 'Permitir a depuração remota?', allow: 'Permitir' },
    { locales: ['pt-PT'], title: 'Permitir depuração remota?', allow: 'Permitir' },
    { locales: ['ru'], title: 'Разрешить удаленную отладку?', allow: 'Разрешить' },
    { locales: ['ja'], title: 'リモート デバッグを許可しますか？', allow: '許可する' },
    { locales: ['de'], title: 'Remote-Fehlerbehebung zulassen?', allow: 'Zulassen' },
    { locales: ['fr'], title: 'Autoriser le débogage à distance\u00a0?', allow: 'Autoriser' },
    { locales: ['fr-CA'], title: 'Autoriser le débogage à distance?', allow: 'Autoriser' },
  ].map((entry) => Object.freeze({ ...entry, locales: Object.freeze(entry.locales) }))
);
