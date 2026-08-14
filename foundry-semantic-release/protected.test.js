"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  applyCatalogUrls,
  buildProtectedManifest,
  foundryHubManifestUrl,
  foundryReleaseManifestUrl,
  isFoundryProtected,
} = require("./protected.js");

const base = { id: "death-ledger", title: "Death Ledger", version: "1.0.0" };

describe("isFoundryProtected", () => {
  it("is true only when FOUNDRY_PROTECTED=true and Foundry API is not skipped", () => {
    assert.equal(isFoundryProtected({ FOUNDRY_PROTECTED: "true" }), true);
    assert.equal(isFoundryProtected({ FOUNDRY_PROTECTED: "true", SKIP_FOUNDRY_API: "true" }), false);
    assert.equal(isFoundryProtected({ FOUNDRY_PROTECTED: "false" }), false);
    assert.equal(isFoundryProtected({}), false);
  });
});

describe("applyCatalogUrls", () => {
  it("keeps a download field and forces protected false for CMS proxy", () => {
    const { urls, mode } = applyCatalogUrls(
      { ...base, protected: true },
      {
        packageId: "death-ledger",
        version: "1.2.3",
        manifestBaseUrl: "https://cms.futurehax.com/api/v1/manifest",
        gcsBucket: "bucket",
        customDomain: "downloads.r2plays.games",
      },
    );
    assert.equal(mode, "cms-proxy");
    assert.equal(urls.protected, false);
    assert.equal(urls.manifest, "https://cms.futurehax.com/api/v1/manifest/death-ledger");
    assert.equal(
      urls.download,
      "https://cms.futurehax.com/api/v1/download/death-ledger/v1.2.3",
    );
  });

  it("uses latest/module.json and versioned zip on the public CDN", () => {
    const { urls, mode } = applyCatalogUrls(base, {
      packageId: "pb-dice-themes",
      version: "1.0.0",
      gcsBucket: "bucket",
      customDomain: "downloads.r2plays.games",
    });
    assert.equal(mode, "cdn");
    assert.equal(
      urls.manifest,
      "https://downloads.r2plays.games/futurehax/pb-dice-themes/latest/module.json",
    );
    assert.equal(
      urls.download,
      "https://downloads.r2plays.games/futurehax/pb-dice-themes/v1.0.0/module.zip",
    );
  });
});

describe("buildProtectedManifest", () => {
  it("sets the R2 manifest, protected true, and omits download", () => {
    const catalog = applyCatalogUrls(base, {
      packageId: "boss-effect-reminder",
      version: "1.1.1",
      manifestBaseUrl: "https://cms.futurehax.com/api/v1/manifest",
    }).urls;
    const hub = buildProtectedManifest(catalog, "boss-effect-reminder");
    assert.equal(hub.protected, true);
    assert.equal(
      hub.manifest,
      "https://r2.foundryvtt.com/packages-public/boss-effect-reminder/module.json",
    );
    assert.equal(Object.hasOwn(hub, "download"), false);
    assert.equal(catalog.download.includes("cms.futurehax.com"), true);
  });
});

describe("foundryReleaseManifestUrl", () => {
  it("uses R2 for protected Hub releases and the catalog URL otherwise", () => {
    assert.equal(
      foundryReleaseManifestUrl({
        protectedHub: true,
        packageId: "death-ledger",
        catalogManifestUrl: "https://downloads.r2plays.games/futurehax/death-ledger/latest/module.json",
      }),
      foundryHubManifestUrl("death-ledger"),
    );
    assert.equal(
      foundryReleaseManifestUrl({
        protectedHub: false,
        packageId: "pb-dice-themes",
        catalogManifestUrl: "https://downloads.r2plays.games/futurehax/pb-dice-themes/latest/module.json",
      }),
      "https://downloads.r2plays.games/futurehax/pb-dice-themes/latest/module.json",
    );
  });
});
