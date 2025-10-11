import fs from "fs";
import axios from "axios";

const token = process.env.GITHUB_TOKEN;

const headers = {
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
};

async function main() {
  console.log("🔎 Searching for repositories with topic 'bruce-interpreter-app'...");

  const repos = [];
  let page = 1;
  const perPage = 50;
  const errors = [];

  // Paginate through search results
  while (true) {
    const searchUrl = `https://api.github.com/search/repositories?q=topic:bruce-interpreter-app&per_page=${perPage}&page=${page}`;
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

  const results = [];

  for (const repo of repos) {
    const { full_name, owner, name } = repo;
    const defaultBranch = repo.default_branch || "main";
    console.log(`➡️  Processing ${full_name} (default branch: ${defaultBranch})...`);

    let metadataData = null;
    let latestRelease = null;
    let hasError = false;

    // Fetch metadata.json
    try {
      const metadataUrl = `https://raw.githubusercontent.com/${owner.login}/${name}/${defaultBranch}/metadata.json`;
      const metadataRes = await axios.get(metadataUrl);

      // Ensure response is parseable JSON
      if (typeof metadataRes.data === "string") {
        metadataData = JSON.parse(metadataRes.data);
      } else if (typeof metadataRes.data === "object") {
        metadataData = metadataRes.data;
      } else {
        throw new Error("Response is not valid JSON");
      }

      console.log(`✅ Found metadata.json`);
    } catch (err) {
      const msg = `⚠️  No metadata.json in ${full_name} (${err.response?.status || err.message})`;
      console.warn(msg);
      errors.push(msg);
      hasError = true;
    }

    // Fetch latest release (only if metadata.json succeeded)
    if (!hasError) {
      try {
        const releaseUrl = `https://api.github.com/repos/${owner.login}/${name}/releases/latest`;
        const releaseRes = await axios.get(releaseUrl, { headers });
        latestRelease = {
          tag_name: releaseRes.data.tag_name,
          name: releaseRes.data.name,
          published_at: releaseRes.data.published_at,
          html_url: releaseRes.data.html_url,
        };
        console.log(`🏷️  Latest release: ${latestRelease.tag_name}`);
      } catch (err) {
        if (err.response && err.response.status === 404) {
          const msg = `ℹ️  No releases found for ${full_name}`;
          console.warn(msg);
          errors.push(msg);
        } else {
          const msg = `⚠️  Error fetching release info for ${full_name}: ${err.message}`;
          console.warn(msg);
          errors.push(msg);
        }
        hasError = true;
      }
    }

    // Only include repos with no errors
    if (hasError) {
      console.log(`🚫 Skipping ${full_name} due to errors.\n`);
      continue;
    }

    results.push({
      repo: name,
      owner: owner.login,
      default_branch: defaultBranch,
      latest_release: latestRelease,
      metadata: metadataData
    });

    console.log(""); // blank line for readability
  }

  // Write results
  fs.writeFileSync("releases.json", JSON.stringify(results, null, 2));
  console.log(`🎉 releases.json generated successfully! (${results.length} repos included)`);

  // Write errors to ERRORS.md
  const timestamp = new Date().toISOString();
  const errorMarkdown = [
    `# ❗ Error Report`,
    ``,
    `Generated: ${timestamp}`,
    ``,
    errors.length === 0
      ? "✅ No errors or warnings detected this run!"
      : `### ${errors.length} issues detected:\n` + errors.map(e => `- ${e}`).join("\n"),
    ``,
  ].join("\n");

  fs.writeFileSync("ERRORS.md", errorMarkdown);
  console.log(`📝 ERRORS.md written (${errors.length} entries).`);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message);
  fs.writeFileSync("ERRORS.md", `# ❌ Fatal Error\n\n${err.message}`);
  process.exit(1);
});
