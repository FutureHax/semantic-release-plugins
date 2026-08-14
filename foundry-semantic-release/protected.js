"use strict";

const FOUNDRY_R2_HOST = "https://r2.foundryvtt.com/packages-public";

function isFoundryProtected(env = process.env) {
  return env.FOUNDRY_PROTECTED === "true" && env.SKIP_FOUNDRY_API !== "true";
}

function foundryHubManifestUrl(packageId) {
  return `${FOUNDRY_R2_HOST}/${packageId}/module.json`;
}

function applyCatalogUrls(moduleJson, opts) {
  const {
    packageId,
    version,
    githubUrl = "https://github.com",
    repositoryPath,
    gcsBucket,
    customDomain = "downloads.r2plays.games",
    manifestBaseUrl,
  } = opts;

  const next = { ...moduleJson, version };
  if (next.protected === true) {
    next.protected = false;
  }

  if (manifestBaseUrl) {
    next.manifest = `${manifestBaseUrl}/${packageId}`;
    next.download = `${manifestBaseUrl.replace("/manifest", "/download")}/${packageId}/v${version}`;
    if (gcsBucket && customDomain) {
      next.changelog = `https://${customDomain}/futurehax/${packageId}/CHANGELOG.md`;
    }
    return { urls: next, mode: "cms-proxy" };
  }

  if (gcsBucket && customDomain) {
    next.manifest = `https://${customDomain}/futurehax/${packageId}/latest/module.json`;
    next.download = `https://${customDomain}/futurehax/${packageId}/v${version}/module.zip`;
    next.changelog = `https://${customDomain}/futurehax/${packageId}/CHANGELOG.md`;
    return { urls: next, mode: "cdn" };
  }

  if (gcsBucket) {
    next.manifest = `https://storage.googleapis.com/${gcsBucket}/futurehax/${packageId}/latest/module.json`;
    next.download = `https://storage.googleapis.com/${gcsBucket}/futurehax/${packageId}/v${version}/module.zip`;
    next.changelog = `https://storage.googleapis.com/${gcsBucket}/futurehax/${packageId}/CHANGELOG.md`;
    return { urls: next, mode: "gcs" };
  }

  next.manifest = `${githubUrl}/${repositoryPath}/releases/latest/download/module.json`;
  next.download = `${githubUrl}/${repositoryPath}/releases/download/v${version}/module.zip`;
  return { urls: next, mode: "github" };
}

function buildProtectedManifest(moduleJson, packageId) {
  const hub = { ...moduleJson, protected: true, manifest: foundryHubManifestUrl(packageId) };
  delete hub.download;
  return hub;
}

function foundryReleaseManifestUrl({ protectedHub, packageId, catalogManifestUrl }) {
  if (protectedHub) return foundryHubManifestUrl(packageId);
  return catalogManifestUrl;
}

module.exports = {
  FOUNDRY_R2_HOST,
  applyCatalogUrls,
  buildProtectedManifest,
  foundryHubManifestUrl,
  foundryReleaseManifestUrl,
  isFoundryProtected,
};
