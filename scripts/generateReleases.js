import fs from "fs";
import axios from "axios";

const token = process.env.GITHUB_TOKEN;
const headers = {
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
};

// Detect if running manually (workflow_dispatch)
const isManualRun = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
console.log(`🕹️ Run mode: ${isManualRun ? "Manual" : "Scheduled / Automatic"}`);

// Load valid categories from categories.json
const validCategories = JSON.parse(fs.readFileSync("categories.json", "utf-8"));

// Load blocklist (simple array of wildcard strings)
let blocklist = [];
if (fs.existsSync("blocklist.json")) {
  try {
    const raw = JSON.parse(fs.readFileSync("blocklist.json", "utf-8"));
    if (Array.isArray(raw)) {
      blocklist = raw;
    } else {
      console.warn("⚠️  blocklist.json is not an array — ignoring.");
    }
  } catch (e) {
    console.warn("⚠️  Could not parse blocklist.json, ignoring it.");
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

async function main() {
  console.log("🔎 Searching for repositories with topic 'bruce-app-store'...");

  const repos = [];
  let page = 1;
  const perPage = 50;
  const errors = [];

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
  const blocklistHits = [];

  for (const repo of repos) {
    const { full_name, owner, name } = repo;

    // 🔒 Check blocklist first
    if (isBlocked(full_name)) {
      const msg = `🛑 Skipping ${full_name}: Blocked by blocklist.json`;
      blocklistHits.push(msg);
      if (isManualRun) console.warn(msg);
      continue;
    }

    console.log(`➡️  Processing ${full_name}...`);

    let latestRelease = null;
    let metadataData = null;
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

      if (typeof metadataRes.data === "string") {
        metadataData = JSON.parse(metadataRes.data);
      } else if (typeof metadataRes.data === "object") {
        metadataData = metadataRes.data;
      } else {
        throw new Error("Response is not valid JSON");
      }

      // Validate metadata and collect all errors
      const repoErrors = [];

      if (!metadataData.name) repoErrors.push("Missing required field: name");
      if (!metadataData.description) repoErrors.push("Missing required field: description");
      if (!Array.isArray(metadataData.files) || metadataData.files.length === 0) {
        repoErrors.push("Field 'files' is missing or empty");
      }
      if (!metadataData.category) {
        repoErrors.push("Missing required field: category");
      } else if (!validCategories.includes(metadataData.category)) {
        repoErrors.push(`Invalid category '${metadataData.category}'`);
      }

      if (repoErrors.length > 0) {
        repoErrors.forEach(errMsg => {
          const msg = `⚠️  ${full_name}: ${errMsg}`;
          console.warn(msg);
          errors.push(msg);
        });
        hasError = true;
      } else {
        console.log(`✅ Valid metadata.json`);
      }
    } catch (err) {
      const msg = `⚠️  Error fetching metadata.json for ${full_name}: ${err.response?.status || err.message}`;
      console.warn(msg);
      errors.push(msg);
      hasError = true;
    }

    if (hasError) {
      console.log(`🚫 Skipping ${full_name} due to errors.\n`);
      continue;
    }

    // Insert into categorized results
    const category = metadataData.category;
    if (!categorizedResults[category]) categorizedResults[category] = [];
    categorizedResults[category].push({
      repo: name,
      owner: owner.login,
      latest_release: latestRelease,
      metadata: metadataData,
    });

    console.log(""); // blank line
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

  // Write releases.json
  fs.writeFileSync("releases.json", JSON.stringify(sortedCategorizedResults, null, 2));
  console.log(`🎉 releases.json generated successfully! Categories: ${Object.keys(sortedCategorizedResults).length}`);

  // Write ERRORS.md
  const timestamp = new Date().toISOString();
  const sections = [
    `# ❗ Error Report`,
    ``,
  ];

  if (errors.length === 0 && (isManualRun || blocklistHits.length === 0)) {
    sections.push("✅ No errors or warnings detected this run!");
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
