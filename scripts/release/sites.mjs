/**
 * Floor Netlify sites. Path lists match the ignore commands in netlify.toml
 * and apps/admin/netlify.toml. A release that does not touch a site's paths
 * does not build that site.
 */
export const SITES = [
  {
    name: "inventoryobi",
    id: "458b95f4-4adb-4721-97bc-400f8bb97597",
    label: "functions (inventoryobi)",
    paths: ["netlify", "shared", "netlify.toml", "package.json", "package-lock.json"],
  },
  {
    name: "openbox-floor-admin",
    id: "d2dd687e-3e46-4bc2-87e0-8be04affec41",
    label: "admin (openbox-floor-admin)",
    paths: ["apps/admin", "packages", "shared", "package.json", "package-lock.json"],
  },
];

export const PROJECT_REF = "zoukmsmbztcuyoslvikp";
export const RELEASE_BRANCH = "release";
export const MASTER_BRANCH = "master";
export const PREVIOUS_TAG = "floor-release-previous";
export const MAIL_TO = "pgg124@gmail.com";

export function fileAffectsSite(file, site) {
  return site.paths.some((path) => file === path || file.startsWith(`${path}/`));
}

export function sitesForFiles(files) {
  return SITES.filter((site) => files.some((file) => fileAffectsSite(file, site)));
}
