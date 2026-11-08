const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { execSync } = require("child_process");
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const {
  applyCatalogUrls,
  buildProtectedManifest,
  foundryReleaseManifestUrl,
  isFoundryProtected,
} = require("./protected.js");

// Kept in this file: workflows download index.js on its own.
const FOUNDRY_RELEASE_API_URL = "https://api.foundryvtt.com/_api/packages/release_version/";
const STATUS_FILE = "foundry-release-status.json";
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 120;
const TRANSIENT_RETRY_SECONDS = 5;

class FoundryReleaseError extends Error {
  constructor(message, { code = "EFOUNDRYRELEASE", details, status } = {}) {
    super(message);
    this.name = "SemanticReleaseError";
    this.semanticRelease = true;
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

function foundryApiEnabled(env = process.env) {
  return env.SKIP_FOUNDRY_API !== "true";
}

function releaseToken(env = process.env) {
  return (env.PACKAGE_RELEASE_TOKEN || "").trim();
}

function missingTokenError() {
  return new FoundryReleaseError("PACKAGE_RELEASE_TOKEN is not set but Foundry publishing is enabled.", {
    code: "ENOFOUNDRYTOKEN",
    details: [
      "SKIP_FOUNDRY_API is not true, so this release must update the foundryvtt.com package listing.",
      "Add a PACKAGE_RELEASE_TOKEN repository secret (Package Release Token on the package's Foundry edit page)",
      "and pass it to the release job (`secrets: inherit` for the reusable workflow).",
      "Premium or unlisted modules should set `skip-foundry-api: true` instead.",
    ].join(" "),
  });
}

function assertFoundryToken(env = process.env) {
  if (foundryApiEnabled(env) && !releaseToken(env)) {
    throw missingTokenError();
  }
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { raw: text };
  }
}

function errorEntries(data) {
  if (!data || typeof data !== "object" || !data.errors || typeof data.errors !== "object") return [];
  return Object.values(data.errors).flatMap((value) => (Array.isArray(value) ? value : [value]));
}

/** Foundry rejects a re-sent package+version with 400 `unique_together`; the listing already has it. */
function isAlreadyReleased(data) {
  return errorEntries(data).some(
    (entry) =>
      (entry && entry.code === "unique_together") ||
      /already exists/i.test(typeof entry === "string" ? entry : (entry && entry.message) || ""),
  );
}

function isErrorBody(data) {
  return Boolean(data && typeof data === "object" && (data.status === "error" || errorEntries(data).length > 0));
}

function describeBody(data) {
  if (data && typeof data === "object" && "raw" in data) return String(data.raw).slice(0, 500);
  return JSON.stringify(data).slice(0, 500);
}

function retryAfterSeconds(response) {
  const header = response.headers && response.headers.get ? response.headers.get("Retry-After") : null;
  const seconds = Number.parseInt(header || "", 10);
  const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(wait + 1, MAX_RETRY_AFTER_SECONDS);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST one release to the Foundry Package Release API.
 *
 * Resolves `{ outcome: "published" | "dry-run" | "already-exists", data }`. Rejects with a
 * FoundryReleaseError on a missing token, a non-2xx or `"status": "error"` response, or a thrown
 * request. A 429, 5xx, or network error is retried once (after Retry-After for 429).
 */
async function publishFoundryRelease({
  token,
  payload,
  logger = console,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
}) {
  if (!token || !String(token).trim()) throw missingTokenError();

  const label = `${payload.id} v${payload.release && payload.release.version}`;
  const dryRun = Boolean(payload["dry-run"]);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const isLastAttempt = attempt === 2;
    let response;
    try {
      response = await fetchImpl(FOUNDRY_RELEASE_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: String(token).trim() },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (!isLastAttempt) {
        logger.warn(
          `Foundry API request for ${label} threw (${error.message}); retrying in ${TRANSIENT_RETRY_SECONDS}s`,
        );
        await sleep(TRANSIENT_RETRY_SECONDS * 1000);
        continue;
      }
      throw new FoundryReleaseError(`Foundry API request for ${label} failed: ${error.message}`, {
        code: "EFOUNDRYREQUEST",
      });
    }

    const data = parseBody(await response.text());

    if (response.ok && !isErrorBody(data)) {
      return { outcome: dryRun ? "dry-run" : "published", data };
    }

    if (isAlreadyReleased(data)) {
      return { outcome: "already-exists", data };
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && !isLastAttempt) {
      const wait = response.status === 429 ? retryAfterSeconds(response) : TRANSIENT_RETRY_SECONDS;
      logger.warn(`Foundry API returned ${response.status} for ${label}; retrying once in ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }

    throw new FoundryReleaseError(`Foundry API rejected ${label}: HTTP ${response.status} ${describeBody(data)}`, {
      code: "EFOUNDRYAPI",
      status: response.status,
    });
  }

  throw new FoundryReleaseError(`Foundry API request for ${label} did not complete`);
}

function writeFoundryReleaseStatus(status, cwd = process.cwd()) {
  fs.writeFileSync(path.join(cwd, STATUS_FILE), JSON.stringify(status, null, 2) + "\n");
}

async function verifyConditions(_pluginConfig, context) {
  const { logger } = context;
  if (!foundryApiEnabled()) {
    logger.log("SKIP_FOUNDRY_API=true, the Foundry VTT package listing will not be updated");
    return;
  }
  assertFoundryToken();
  logger.log("PACKAGE_RELEASE_TOKEN is set, the Foundry VTT package listing will be updated on release");
}

async function verifyRelease(pluginConfig, context) {
  const { nextRelease, logger, options } = context;
  if (!(options && options.dryRun) || !foundryApiEnabled()) return;

  const { payload } = await foundryReleasePayload(pluginConfig, nextRelease.version, { dryRun: true });
  const result = await publishFoundryRelease({ token: releaseToken(), payload, logger });
  logger.log(`✓ Foundry API dry run accepted ${payload.id} v${nextRelease.version} (${result.outcome})`);
}

async function prepare(pluginConfig, context) {
  const { nextRelease, logger } = context;
  const { version } = nextRelease;

  const githubUrl = pluginConfig.githubUrl || "https://github.com";
  const repositoryPath =
    pluginConfig.repositoryPath || "FutureHax/scattered-seafloor-module";

  const modulePath = path.join(process.cwd(), "foundry_vtt", "module.json");
  const moduleContent = await readFile(modulePath, "utf8");
  const moduleJson = JSON.parse(moduleContent);
  const packageId = pluginConfig.packageId || moduleJson.id || "scattered-seafloor";

  const { urls: catalogJson, mode } = applyCatalogUrls(moduleJson, {
    packageId,
    version,
    githubUrl,
    repositoryPath,
    gcsBucket: process.env.GCS_BUCKET_NAME,
    customDomain: process.env.CDN_DOMAIN || "downloads.r2plays.games",
    manifestBaseUrl: process.env.MANIFEST_BASE_URL,
  });

  logger.log(`Using ${mode} URLs for catalog/CMS zip`);

  await writeFile(modulePath, JSON.stringify(catalogJson, null, 2) + "\n");
  logger.log(`Updated module.json to version ${version}`);
  logger.log(`Set catalog manifest URL: ${catalogJson.manifest}`);
  logger.log(`Set catalog download URL: ${catalogJson.download}`);

  await writeFile(
    path.join(process.cwd(), "module.json"),
    JSON.stringify(catalogJson, null, 2) + "\n",
  );
  logger.log(`Copied catalog module.json to root for GitHub release upload`);

  await createModuleZip(version, logger, {
    destName: "module.zip",
    moduleJson: catalogJson,
  });

  if (isFoundryProtected()) {
    const hubJson = buildProtectedManifest(catalogJson, packageId);
    await writeFile(
      path.join(process.cwd(), "module-foundry.json"),
      JSON.stringify(hubJson, null, 2) + "\n",
    );
    await createModuleZip(version, logger, {
      destName: "module-foundry.zip",
      moduleJson: hubJson,
    });
    logger.log(`Built Foundry Hub zip with protected R2 manifest ${hubJson.manifest}`);
  }
}

function createModuleZip(version, logger, { destName, moduleJson }) {
  const payload = { ...moduleJson, version };
  logger.log(`Creating ${destName} with version ${version}`);

  // Loaded lazily so the Foundry publish path can be unit-tested without consumer dependencies.
  const archiver = require("archiver");
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(path.join(process.cwd(), destName));
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      logger.log(`Created ${destName} (${archive.pointer()} bytes)`);
      resolve();
    });

    archive.on("error", reject);
    archive.pipe(output);

    archive.glob("**/*", {
      cwd: path.join(process.cwd(), "foundry_vtt"),
      ignore: ["node_modules/**", ".git/**", ".gitignore", "module.json"],
    });

    archive.append(JSON.stringify(payload, null, 2) + "\n", {
      name: "module.json",
    });

    archive.finalize();
  });
}

async function publish(pluginConfig, context) {
  const { nextRelease, logger } = context;
  const { version } = nextRelease;

  const manifestBaseUrl = process.env.MANIFEST_BASE_URL;
  const gcsBucket = process.env.GCS_BUCKET_NAME;
  const gcsPrivateBucket = process.env.GCS_PRIVATE_BUCKET_NAME;
  const uploadBucket = manifestBaseUrl && gcsPrivateBucket ? gcsPrivateBucket : gcsBucket;

  const modulePath = path.join(process.cwd(), "foundry_vtt", "module.json");
  const moduleContent = await readFile(modulePath, "utf8");
  const moduleJson = JSON.parse(moduleContent);
  const packageId = pluginConfig.packageId || moduleJson.id || "scattered-seafloor";

  if (uploadBucket) {
    const isPrivate = !!(manifestBaseUrl && gcsPrivateBucket);
    logger.log(`Uploading catalog artifacts to GCS ${isPrivate ? "private" : "CDN"} bucket (${uploadBucket})...`);

    try {
      const moduleZipPath = path.join(process.cwd(), "module.zip");
      const moduleJsonPath = path.join(process.cwd(), "module.json");

      if (!fs.existsSync(moduleZipPath)) {
        logger.warn("module.zip not found, skipping GCS upload");
      } else {
        execSync(
          `gsutil -q cp ${moduleZipPath} gs://${uploadBucket}/futurehax/${packageId}/v${version}/`,
          { stdio: "inherit" },
        );
        execSync(
          `gsutil -q cp ${moduleJsonPath} gs://${uploadBucket}/futurehax/${packageId}/v${version}/`,
          { stdio: "inherit" },
        );
        execSync(
          `gsutil -m setmeta -h "Cache-Control:public, max-age=31536000, immutable" "gs://${uploadBucket}/futurehax/${packageId}/v${version}/**"`,
          { stdio: "inherit" },
        );

        execSync(
          `gsutil -q cp ${moduleZipPath} gs://${uploadBucket}/futurehax/${packageId}/latest/`,
          { stdio: "inherit" },
        );
        execSync(
          `gsutil -q cp ${moduleJsonPath} gs://${uploadBucket}/futurehax/${packageId}/latest/`,
          { stdio: "inherit" },
        );
        execSync(
          `gsutil -m setmeta -h "Cache-Control:no-cache, no-store, must-revalidate" "gs://${uploadBucket}/futurehax/${packageId}/latest/**"`,
          { stdio: "inherit" },
        );

        logger.log(`✓ Catalog artifacts uploaded to ${isPrivate ? "private" : "CDN"} bucket`);
        logger.log(`  Versioned: gs://${uploadBucket}/futurehax/${packageId}/v${version}/`);
        logger.log(`  Latest: gs://${uploadBucket}/futurehax/${packageId}/latest/`);
      }
    } catch (error) {
      logger.warn("Failed to upload to GCS:", error.message);
    }
  } else {
    logger.log("GCS_BUCKET_NAME not set, skipping GCS upload");
  }

  // Recorded instead of thrown so @semantic-release/github still creates the release for the pushed tag.
  const foundry = await publishFoundryListing(pluginConfig, version, logger);
  writeFoundryReleaseStatus({ version, ...foundry });
  if (foundry.outcome === "failed" && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::error title=Foundry listing not updated::${foundry.message}`);
  }
}

async function foundryReleasePayload(pluginConfig, version, { dryRun = pluginConfig.dryRun || false } = {}) {
  const githubUrl = pluginConfig.githubUrl || "https://github.com";
  const repositoryPath = pluginConfig.repositoryPath || "FutureHax/scattered-seafloor-module";
  const gcsBucket = process.env.GCS_BUCKET_NAME;
  const customDomain = process.env.CDN_DOMAIN || "downloads.r2plays.games";
  const modulePath = path.join(process.cwd(), "foundry_vtt", "module.json");
  const moduleJson = JSON.parse(await readFile(modulePath, "utf8"));
  const packageId = pluginConfig.packageId || moduleJson.id || "scattered-seafloor";
  const protectedHub = isFoundryProtected();

  const catalogManifestUrl =
    gcsBucket && customDomain
      ? `https://${customDomain}/futurehax/${packageId}/latest/module.json`
      : gcsBucket
        ? `https://storage.googleapis.com/${gcsBucket}/futurehax/${packageId}/latest/module.json`
        : `${githubUrl}/${repositoryPath}/releases/latest/download/module.json`;

  const payload = {
    id: packageId,
    "dry-run": dryRun,
    release: {
      version: version,
      manifest: foundryReleaseManifestUrl({ protectedHub, packageId, catalogManifestUrl }),
      notes:
        gcsBucket && customDomain
          ? `https://${customDomain}/futurehax/${packageId}/CHANGELOG.md`
          : `${githubUrl}/${repositoryPath}/releases/tag/v${version}`,
      compatibility: moduleJson.compatibility || {
        minimum: "12",
        verified: "12",
        maximum: "",
      },
    },
  };
  return { payload, packageId, protectedHub };
}

async function publishFoundryListing(pluginConfig, version, logger) {
  if (!foundryApiEnabled()) {
    logger.log("SKIP_FOUNDRY_API=true, skipping Foundry VTT package update");
    return { outcome: "skipped" };
  }

  const { payload, packageId, protectedHub } = await foundryReleasePayload(pluginConfig, version);
  logger.log(`Updating Foundry VTT package listing for ${packageId} v${version}...`);
  if (protectedHub) {
    logger.log(
      "Protected Hub zip is module-foundry.zip. Foundry hosts premium packages via the Premium Content Uploader (https://foundryvtt.com/me/packages); the JSON release API only records the R2 manifest URL.",
    );
  }

  try {
    const { outcome, data } = await publishFoundryRelease({ token: releaseToken(), payload, logger });
    if (outcome === "already-exists") {
      logger.log(`✓ Foundry VTT listing already has ${packageId} v${version}; nothing to do`);
    } else if (outcome === "dry-run") {
      logger.log(`✓ Foundry API dry run successful: ${data.message || "Success"}`);
    } else {
      logger.log(`✓ Successfully updated Foundry VTT package listing!`);
      if (data.page) {
        logger.log(`  Package page: ${data.page}`);
      }
    }
    return { outcome, packageId };
  } catch (error) {
    logger.error(`Failed to update Foundry VTT package listing: ${error.message}`);
    return { outcome: "failed", packageId, message: error.message, code: error.code };
  }
}

async function success(_pluginConfig, context) {
  const { logger } = context;
  logger.log(
    "Leaving module.zip, module.json, and any module-foundry.* artifacts in place for downstream steps.",
  );

  const statusPath = path.join(process.cwd(), STATUS_FILE);
  const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf8")) : null;
  if (status && status.outcome === "failed") {
    throw new FoundryReleaseError(`Released v${status.version}, but the Foundry VTT listing was not updated.`, {
      code: status.code || "EFOUNDRYAPI",
      details: [
        status.message,
        "The git tag and GitHub release are in place. Re-publishing the same version is safe (Foundry answers",
        "`already exists` once it has it), for example with the foundry MCP `foundry_release_version` tool.",
      ].join(" "),
    });
  }
}

module.exports = {
  verifyConditions,
  verifyRelease,
  prepare,
  publish,
  success,
  foundryReleasePayload,
  publishFoundryRelease,
  isAlreadyReleased,
  STATUS_FILE,
};
