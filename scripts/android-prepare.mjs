/**
 * After `npx cap sync android`, patch the generated Android project.
 * Idempotent. Does not touch the iOS project or Codemagic.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const android = path.join(root, "apps", "adapter", "android");
const manifestPath = path.join(android, "app", "src", "main", "AndroidManifest.xml");
const stylesPath = path.join(android, "app", "src", "main", "res", "values", "styles.xml");
const gradlePath = path.join(android, "app", "build.gradle");

if (!existsSync(manifestPath)) {
  console.error("Android project missing. From apps/adapter: npx cap add android");
  process.exit(1);
}

function patch(file, transform) {
  const before = readFileSync(file, "utf8");
  const after = transform(before);
  if (after !== before) {
    writeFileSync(file, after);
    console.log("patched", path.relative(root, file));
  } else {
    console.log("ok", path.relative(root, file));
  }
}

patch(manifestPath, (xml) => {
  let next = xml;
  if (!next.includes('android:scheme="floor"')) {
    const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="floor" />
            </intent-filter>`;
    const activityClose = next.indexOf("</activity>");
    if (activityClose === -1) throw new Error("Main activity not found in AndroidManifest.xml");
    next = next.slice(0, activityClose) + filter + "\n        " + next.slice(activityClose);
  }
  if (!next.includes("windowSoftInputMode")) {
    next = next.replace(
      "<activity",
      '<activity android:windowSoftInputMode="adjustResize"',
    );
  }
  if (!next.includes('android:name="com.squareup"')) {
    const queries = `
    <queries>
        <package android:name="com.squareup" />
    </queries>`;
    next = next.replace("<application", queries + "\n    <application");
  }
  const permissions = [
    "android.permission.CAMERA",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_EXTERNAL_STORAGE",
  ];
  for (const permission of permissions) {
    if (next.includes(permission)) continue;
    next = next.replace(
      "</manifest>",
      `    <uses-permission android:name="${permission}" />\n</manifest>`,
    );
  }
  return next;
});

if (existsSync(stylesPath)) {
  patch(stylesPath, (xml) => {
    let next = xml;
    const items = [
      ["android:statusBarColor", "@color/floor_bg"],
      ["android:navigationBarColor", "@color/floor_bg"],
      ["android:windowBackground", "@color/floor_bg"],
      ["android:windowOptOutEdgeToEdgeEnforcement", "true"],
    ];
    if (!next.includes("floor_bg")) {
      // Color resource is added below. Reference it once the name exists.
    }
    for (const [name, value] of items) {
      if (next.includes(name)) continue;
      next = next.replace(
        "</style>",
        `    <item name="${name}">${value}</item>\n    </style>`,
      );
    }
    return next;
  });
}

const colorsPath = path.join(android, "app", "src", "main", "res", "values", "colors.xml");
if (!existsSync(colorsPath)) {
  writeFileSync(
    colorsPath,
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="floor_bg">#0B0B0B</color>
</resources>
`,
  );
  console.log("wrote", path.relative(root, colorsPath));
} else {
  patch(colorsPath, (xml) => {
    if (xml.includes("floor_bg")) return xml;
    return xml.replace("</resources>", `    <color name="floor_bg">#0B0B0B</color>\n</resources>`);
  });
}

if (existsSync(gradlePath)) {
  patch(gradlePath, (gradle) => {
    if (gradle.includes("signingConfig signingConfigs.debug")) return gradle;
    if (!gradle.includes("buildTypes")) return gradle;
    return gradle.replace(
      /release\s*\{/,
      `release {
            signingConfig signingConfigs.debug`,
    );
  });
}

console.log("android-prepare done");
