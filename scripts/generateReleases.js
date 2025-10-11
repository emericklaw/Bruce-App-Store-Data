import fs from "fs";
import axios from "axios";

const token = process.env.GITHUB_TOKEN;
const headers = {
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
};

// Detect if running manually (workflow_dispatch)
const isManualRun = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const verbose = process.env.VERBOSE === "true";
console.log(`🕹️ Run mode: ${isManualRun ? "Manual" : "Scheduled / Automatic"}`);

// Load valid categories from categories.json
const validCategories = JSON.parse(fs.readFileSync("categories.json", "utf-8"));

// Load blocklist (array of wildcard strings)
let blocklist = [];
if (fs.existsSync("blocklist.json")) {
  try {
    const raw = JSON.parse(fs.readFileSync("blocklist.json", "utf-8"));
    if (Array.isArray(raw)) blocklist = raw;
    else console.warn("⚠️ blocklist.json is not an array — ignoring.");
  } catch (e) {
    console.warn("⚠️ Could not parse blocklist.json, ignoring it.");
  }
}

// Utility: escape regex special chars
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Utility: wildcard match
function wildcardMatch(pattern, text) {
  const regex = new RegExp("^" + pattern.split("*").map(escapeRegex).join(".*") + "$", "i");
  return regex.test(text);
}

// Check if repo is blocked
function isBlocked(fullName) {
  return blocklist.some(pattern => wildcardMatch(pattern, fullName));
}

// Security check for file paths
function hasUnsafePath(value) {
  const invalidChars = /(\.\.|\/|\\|~)/;
  return invalidChars.test(value);
}

// Validate one metadata entry
function validateMetadata(entry, full_name, index = null) {
  const prefix = index !== null ? `[entry ${index}] ` : "";
  const errors = [];

  if (!entry.name) errors.push(`${prefix}Missing required field: name`);
  if (!entry.description) errors.push(`${prefix}Missing required field: description`);

  // Validate files
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    errors.push(`${prefix}Field 'files' is missing or empty`);
  } else {
    entry.files.forEach((file, i) => {
      if (typeof file !== "object" || !file.source || !file.destination) {
        errors.push(`${prefix}files[${i}] must be an object with 'source' and 'destination' keys`);
        return;
      }
      if (hasUnsafePath(file.source))
        errors.push(`${prefix}files[${i}].source contains invalid or unsafe characters`);
      if (hasUnsafePath(file.destination))
        errors.push(`${prefix}files[${i}].destination contains invalid or unsafe characters`);
    });
  }

  if (!entry.category) errors.push(`${prefix}Missing required field: category`);
  else if (!validCategories.includes(entry.category))
    errors.push(`${prefix}Invalid category '${entry.category}'`);

  return errors;
}

async function main() {
  console.log("🔎 Searching for repositories with topic 'bruce-app-store'...");

  const repos = [];
  let page = 1;
  const perPage = 50;
  const errors = [];
  const blocklistHits = [];

  while (true) {
    const searchUrl = `https://api.github.com/search/repositories?q=topic:bruce-app-store&per_page=${perPage}&page=${page}`;
    try {
      const res = await axios.get(searchUrl, { headers });
      repos.push(...res.data.items);
      if (res.data.items.length < perPage) break;
      page++;
    } catch (err) {
      errors.push(`❌ Failed to search repositories (page ${page}): ${err.message}`);
      break;
    }
  }

  console.log(`📦 Found ${repos.length} repositories.\n`);

  const categorizedResults = {}; // { category: [apps] }

  for (const repo of repos) {
    const { full_name, owner, name } = repo;

    // Check blocklist first
    if (isBlocked(full_name)) {
      const msg = `🛑 Skipping ${full_name}: Blocked by blocklist.json`;
      blocklistHits.push(msg);
      if (isManualRun && verbose) console.warn(msg);
      continue;
    }

    console.log(`➡️  Processing ${full_name}...`);

    let latestRelease = null;
    let metadataRaw = null;
    let hasError = false;

    try {
      // Fetch latest release
      const releaseUrl = `https://api.github.com/repos/${owner.login}/${name}/releases/latest`;
      const releaseRes = await axios.get(releaseUrl, { headers });
      latestRelease = {
        tag_name: releaseRes.data.tag_name,
        name: releaseRes.data.name,
        published_at: releaseRes.data.published_at,
      };

      // Fetch metadata.json from release tag
      const metadataUrl = `https://raw.githubusercontent.com/${owner.login}/${name}/${latestRelease.tag_name}/metadata.json`;
      const metadataRes = await axios.get(metadataUrl);

      metadataRaw =
        typeof metadataRes.data === "string"
          ? JSON.parse(metadataRes.data)
          : metadataRes.data;

      // Handle either single or multiple entries
      const entries = Array.isArray(metadataRaw) ? metadataRaw : [metadataRaw];

      let repoHasError = false;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const entryErrors = validateMetadata(entry, full_name, Array.isArray(metadataRaw) ? i : null);

        if (entryErrors.length > 0) {
          entryErrors.forEach(err => {
            const msg = `⚠️  ${full_name}: ${err}`;
            console.warn(msg);
            errors.push(msg);
          });
          repoHasError = true;
          continue;
        }

        // Add to categorized results
        const category = entry.category;
        if (!categorizedResults[category]) categorizedResults[category] = [];

        categorizedResults[category].push({
          repo: name,
          owner: owner.login,
          latest_release: latestRelease,
          metadata: entry,
        });
      }

      if (repoHasError) hasError = true;
      else if (verbose) console.log(`✅ Valid metadata.json`);
    } catch (err) {
      const msg = `⚠️  Error fetching metadata.json for ${full_name}: ${err.response?.status || err.message}`;
      console.warn(msg);
      errors.push(msg);
      hasError = true;
    }

    if (hasError) {
      console.log(`🚫 Skipping ${full_name} (some entries invalid).\n`);
    } else {
      console.log("");
    }
  }

  // Sort apps in each category by metadata.name
  for (const cat of Object.keys(categorizedResults)) {
    categorizedResults[cat].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  // Sort categories alphabetically
  const sortedCategorizedResults = {};
  Object.keys(categorizedResults)
    .sort()
    .forEach(cat => {
      sortedCategorizedResults[cat] = categorizedResults[cat];
    });

  // Merge releases_manual.json if it exists
  if (fs.existsSync("releases_manual.json")) {
    try {
      const manualData = JSON.parse(fs.readFileSync("releases_manual.json", "utf-8"));
      for (const [category, apps] of Object.entries(manualData)) {
        if (!sortedCategorizedResults[category]) sortedCategorizedResults[category] = [];

        for (const app of apps) {
          // Skip if same owner/repo AND metadata.name exists
          const exists = sortedCategorizedResults[category].some(
            a => a.owner === app.owner && a.repo === app.repo && a.metadata.name === app.metadata.name
          );
          if (!exists) sortedCategorizedResults[category].push(app);
        }
      }
    } catch (e) {
      console.warn("⚠️ Could not parse releases_manual.json, ignoring it.");
    }
  }

  // Re-sort apps after merge
  for (const cat of Object.keys(sortedCategorizedResults)) {
    sortedCategorizedResults[cat].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  // Write releases.json
  fs.writeFileSync("releases.json", JSON.stringify(sortedCategorizedResults, null, 2));
  console.log(`🎉 releases.json generated successfully.`);

  // Write ERRORS.md
  const sections = ["# ❗ Error Report", ""];

  if (errors.length === 0 && (!isManualRun || blocklistHits.length === 0)) {
    sections.push("✅ No errors or warnings detected");
  } else {
    if (errors.length > 0) {
      sections.push(`### ⚠️ ${errors.length} Metadata / Processing Issues`);
      sections.push(errors.map(e => `- ${e}`).join("\n"));
      sections.push("");
    }
    if (blocklistHits.length > 0 && isManualRun) {
      sections.push(`### 🛑 ${blocklistHits.length} Blocked Repositories`);
      sections.push(blocklistHits.map(e => `- ${e}`).join("\n"));
    }
  }

  fs.writeFileSync("ERRORS.md", sections.join("\n"));
  console.log(`📝 ERRORS.md written (${errors.length + blocklistHits.length} entries).`);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message);
  fs.writeFileSync("ERRORS.md", `# ❌ Fatal Error\n\n${err.message}`);
  process.exit(1);
});
