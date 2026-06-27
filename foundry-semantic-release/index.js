const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { promisify } = require("util");
const { execSync } = require("child_process");
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

async function prepare(pluginConfig, context) {
  const { nextRelease, logger } = context;
  const { version } = nextRelease;

  // Get GitHub repository URL from config
  const githubUrl = pluginConfig.githubUrl || "https://github.com";
  const repositoryPath =
    pluginConfig.repositoryPath || "FutureHax/scattered-seafloor-module";

  // Update module.json with new version and predictable URLs
  const modulePath = path.join(process.cwd(), "foundry_vtt", "module.json");
  const moduleContent = await readFile(modulePath, "utf8");
  const moduleJson = JSON.parse(moduleContent);

  // Update version
  moduleJson.version = version;

  const gcsBucket = process.env.GCS_BUCKET_NAME;
  const customDomain = process.env.CDN_DOMAIN || "downloads.r2plays.games";
  const packageId = pluginConfig.packageId || "scattered-seafloor";
  const manifestBaseUrl = process.env.MANIFEST_BASE_URL;

  if (manifestBaseUrl) {
    moduleJson.manifest = `${manifestBaseUrl}/${packageId}`;
    moduleJson.download = `${manifestBaseUrl.replace("/manifest", "/download")}/${packageId}/v${version}`;
    if (gcsBucket && customDomain) {
      moduleJson.changelog = `https://${customDomain}/futurehax/${packageId}/CHANGELOG.md`;
    }
    logger.log(`Using CMS proxy URLs (MANIFEST_BASE_URL): ${manifestBaseUrl}`);
  } else if (gcsBucket && customDomain) {
    moduleJson.manifest = `https://${customDomain}/futurehax/${packageId}/latest/module.json`;
    moduleJson.download = `https://${customDomain}/futurehax/${packageId}/v${version}/module.zip`;
    logger.log(`Using CDN URLs with domain: ${customDomain}`);
  } else if (gcsBucket) {
    // Fallback to direct GCS URLs if custom domain not configured
    moduleJson.manifest = `https://storage.googleapis.com/${gcsBucket}/futurehax/${packageId}/latest/module.json`;
    moduleJson.download = `https://storage.googleapis.com/${gcsBucket}/futurehax/${packageId}/v${version}/module.zip`;
    logger.log(`Using direct GCS URLs with bucket: ${gcsBucket}`);
  } else {
    // Fallback to GitHub release URLs if CDN not configured
    moduleJson.manifest = `${githubUrl}/${repositoryPath}/releases/latest/download/module.json`;
    moduleJson.download = `${githubUrl}/${repositoryPath}/releases/download/v${version}/module.zip`;
    logger.log(`Using GitHub release URLs (CDN not configured)`);
  }

  await writeFile(modulePath, JSON.stringify(moduleJson, null, 2) + "\n");
  logger.log(`Updated module.json to version ${version}`);
  logger.log(`Set manifest URL: ${moduleJson.manifest}`);
  logger.log(`Set download URL: ${moduleJson.download}`);

  // Copy the updated module.json to root for GitHub release upload
  await writeFile(
    path.join(process.cwd(), "module.json"),
    JSON.stringify(moduleJson, null, 2) + "\n",
  );
  logger.log(`Copied updated module.json to root for GitHub release upload`);

  // Create module.zip
  await createModuleZip(version, logger);
}

async function createModuleZip(version, logger) {
  // Read the updated module.json to ensure we have the correct version
  const modulePath = path.join(process.cwd(), "foundry_vtt", "module.json");
  const moduleContent = await readFile(modulePath, "utf8");
  const moduleJson = JSON.parse(moduleContent);

  if (moduleJson.version !== version) {
    logger.warn(
      `Warning: module.json version (${moduleJson.version}) doesn't match expected version (${version})`,
    );
    // Force the correct version
    moduleJson.version = version;
  }

  logger.log(`Creating module.zip with version ${version}`);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(path.join(process.cwd(), "module.zip"));
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      logger.log(`Created module.zip (${archive.pointer()} bytes)`);
      resolve();
    });

    archive.on("error", reject);

    archive.pipe(output);

    // Add all files EXCEPT module.json
    archive.glob("**/*", {
      cwd: path.join(process.cwd(), "foundry_vtt"),
      ignore: ["node_modules/**", ".git/**", ".gitignore", "module.json"],
    });

    // Explicitly add module.json with the correct version
    archive.append(JSON.stringify(moduleJson, null, 2) + "\n", {
      name: "module.json",
    });

    archive.finalize();
  });
}

async function publish(pluginConfig, context) {
  const { nextRelease, logger } = context;
  const { version } = nextRelease;

  // Get configuration (needed for both Foundry API and GCS upload)
  const githubUrl = pluginConfig.githubUrl || "https://github.com";
  const repositoryPath =
    pluginConfig.repositoryPath || "FutureHax/scattered-seafloor-module";
  const packageId = pluginConfig.packageId || "scattered-seafloor";
  const dryRun = pluginConfig.dryRun || false;

  const manifestBaseUrl = process.env.MANIFEST_BASE_URL;
  const gcsBucket = process.env.GCS_BUCKET_NAME;
  const gcsPrivateBucket = process.env.GCS_PRIVATE_BUCKET_NAME;
  const uploadBucket = manifestBaseUrl && gcsPrivateBucket ? gcsPrivateBucket : gcsBucket;
  const customDomain = process.env.CDN_DOMAIN || "downloads.r2plays.games";

  if (uploadBucket) {
    const isPrivate = !!(manifestBaseUrl && gcsPrivateBucket);
    logger.log(`Uploading artifacts to GCS ${isPrivate ? "private" : "CDN"} bucket (${uploadBucket})...`);

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

        logger.log(`✓ Artifacts uploaded to ${isPrivate ? "private" : "CDN"} bucket`);
        logger.log(`  Versioned: gs://${uploadBucket}/futurehax/${packageId}/v${version}/`);
        logger.log(`  Latest: gs://${uploadBucket}/futurehax/${packageId}/latest/`);

        if (!isPrivate && customDomain) {
          logger.log(`  CDN Latest: https://${customDomain}/futurehax/${packageId}/latest/module.json`);
          logger.log(`  CDN Version: https://${customDomain}/futurehax/${packageId}/v${version}/module.zip`);
        }
      }
    } catch (error) {
      logger.warn("Failed to upload to GCS:", error.message);
    }
  } else {
    logger.log("GCS_BUCKET_NAME not set, skipping GCS upload");
  }

  const skipFoundryApi = process.env.SKIP_FOUNDRY_API === "true";
  const foundryToken = process.env.PACKAGE_RELEASE_TOKEN;

  if (skipFoundryApi) {
    logger.log("SKIP_FOUNDRY_API=true, skipping Foundry VTT package update");
    return;
  }

  if (!foundryToken) {
    logger.log(
      "PACKAGE_RELEASE_TOKEN not set, skipping Foundry VTT package update",
    );
    return;
  }

  // Read module.json to get compatibility info
  const modulePath = path.join(process.cwd(), "foundry_vtt", "module.json");
  const moduleContent = await readFile(modulePath, "utf8");
  const moduleJson = JSON.parse(moduleContent);

  // Prepare the release data with CDN URLs if available
  // Use latest manifest URL so Foundry can detect updates
  let manifestUrl;
  if (gcsBucket && customDomain) {
    manifestUrl = `https://${customDomain}/futurehax/${packageId}/latest/module.json`;
  } else if (gcsBucket) {
    manifestUrl = `https://storage.googleapis.com/${gcsBucket}/futurehax/${packageId}/latest/module.json`;
  } else {
    manifestUrl = `${githubUrl}/${repositoryPath}/releases/latest/download/module.json`;
  }

  const releaseData = {
    id: packageId,
    "dry-run": dryRun,
    release: {
      version: version,
      manifest: manifestUrl,
      notes: gcsBucket && customDomain
        ? `https://${customDomain}/futurehax/${packageId}/CHANGELOG.md`
        : `${githubUrl}/${repositoryPath}/releases/tag/v${version}`,
      compatibility: moduleJson.compatibility || {
        minimum: "12",
        verified: "12",
        maximum: "",
      },
    },
  };

  logger.log(
    `Updating Foundry VTT package listing for ${packageId} v${version}...`,
  );

  try {
    const response = await fetch(
      "https://api.foundryvtt.com/_api/packages/release_version/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: foundryToken,
        },
        body: JSON.stringify(releaseData),
      },
    );

    // Try to parse response as JSON, but handle cases where it's not JSON
    let responseData;
    const responseText = await response.text();

    try {
      responseData = JSON.parse(responseText);
    } catch {
      // Response is not JSON, likely an error message
      responseData = { error: responseText };
    }

    if (response.ok) {
      if (dryRun) {
        logger.log(
          `✓ Foundry API dry run successful: ${responseData.message || "Success"}`,
        );
      } else {
        logger.log(`✓ Successfully updated Foundry VTT package listing!`);
        if (responseData.page) {
          logger.log(`  Package page: ${responseData.page}`);
        }
      }
    } else {
      logger.error(
        `Failed to update Foundry VTT package listing: ${response.status} ${response.statusText}`,
      );
      if (typeof responseData === "object") {
        logger.error(`Response: ${JSON.stringify(responseData, null, 2)}`);
      } else {
        logger.error(`Response: ${responseText}`);
      }

      // Don't fail the release if Foundry API fails
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        logger.warn(`Rate limited. Retry after ${retryAfter} seconds`);
      }
    }
  } catch (error) {
    logger.error("Error calling Foundry VTT API:", error.message);
    // Don't fail the release if Foundry API fails
  }
}

async function success(pluginConfig, context) {
  const { logger } = context;

  // Clean up the temporary root module.json file
  try {
    const rootModulePath = path.join(process.cwd(), "module.json");
    if (fs.existsSync(rootModulePath)) {
      fs.unlinkSync(rootModulePath);
      logger.log("Cleaned up temporary root module.json file");
    }
  } catch (error) {
    logger.warn("Failed to clean up root module.json:", error.message);
  }

  // Clean up module.zip as well
  try {
    const moduleZipPath = path.join(process.cwd(), "module.zip");
    if (fs.existsSync(moduleZipPath)) {
      fs.unlinkSync(moduleZipPath);
      logger.log("Cleaned up module.zip file");
    }
  } catch (error) {
    logger.warn("Failed to clean up module.zip:", error.message);
  }
}

module.exports = { prepare, publish, success };

