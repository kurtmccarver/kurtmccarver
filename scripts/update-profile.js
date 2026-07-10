const fs = require("node:fs/promises");
const path = require("node:path");

const USERNAME = process.env.GITHUB_USERNAME || "kurtmccarver";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const ROOT = path.resolve(__dirname, "..");

const COLORS = {
  bg: "#161b22",
  fg: "#c9d1d9",
  muted: "#6e7681",
  label: "#ff9d3b",
  value: "#8cc8ff",
  green: "#3fb950",
  red: "#ff7b72",
  border: "#30363d",
};

const INFO_X = 455;

async function github(pathname, options = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "kurtmccarver-profile-readme",
    "X-GitHub-Api-Version": "2022-11-28",
    ...options.headers,
  };

  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }

  const response = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers,
  });

  if (response.status === 202) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${pathname}`);
  }

  return response.json();
}

async function graphql(query, variables) {
  if (!TOKEN) {
    return null;
  }

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "kurtmccarver-profile-readme",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  return payload.errors ? null : payload.data;
}

async function getAllRepos() {
  const repos = [];
  let page = 1;

  while (true) {
    const batch = await github(
      `/users/${USERNAME}/repos?type=owner&sort=updated&per_page=100&page=${page}`,
    );

    if (!batch || batch.length === 0) {
      break;
    }

    repos.push(...batch);

    if (batch.length < 100) {
      break;
    }

    page += 1;
  }

  return repos;
}

function lastPageFromLink(linkHeader) {
  if (!linkHeader) {
    return 0;
  }

  const last = linkHeader.split(",").find((part) => part.includes('rel="last"'));
  if (!last) {
    return 1;
  }

  const match = last.match(/[?&]page=(\d+)/);
  return match ? Number(match[1]) : 1;
}

async function countCommits(repoName) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "kurtmccarver-profile-readme",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${USERNAME}/${repoName}/commits?author=${USERNAME}&per_page=1`,
    { headers },
  );

  if (!response.ok) {
    return 0;
  }

  const commits = await response.json();
  if (!Array.isArray(commits) || commits.length === 0) {
    return 0;
  }

  return lastPageFromLink(response.headers.get("link")) || 1;
}

async function codeFrequency(repoName) {
  try {
    const data = await github(`/repos/${USERNAME}/${repoName}/stats/code_frequency`);
    if (!Array.isArray(data)) {
      return { additions: 0, deletions: 0 };
    }

    return data.reduce(
      (total, week) => ({
        additions: total.additions + Math.max(0, week[1] || 0),
        deletions: total.deletions + Math.abs(Math.min(0, week[2] || 0)),
      }),
      { additions: 0, deletions: 0 },
    );
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

async function languageBytes(repoName) {
  try {
    const data = await github(`/repos/${USERNAME}/${repoName}/languages`);
    if (!data || typeof data !== "object") {
      return 0;
    }

    return Object.values(data).reduce((total, bytes) => total + Number(bytes || 0), 0);
  } catch {
    return 0;
  }
}

async function getStats() {
  const [user, repos, contributionData] = await Promise.all([
    github(`/users/${USERNAME}`),
    getAllRepos(),
    graphql(
      `query ($login: String!) {
        user(login: $login) {
          contributionsCollection {
            contributionCalendar {
              totalContributions
            }
          }
        }
      }`,
      { login: USERNAME },
    ),
  ]);

  const stars = repos.reduce((total, repo) => total + repo.stargazers_count, 0);
  const [commitCounts, frequencies, languageTotals] = await Promise.all([
    Promise.all(repos.map((repo) => countCommits(repo.name))),
    Promise.all(repos.map((repo) => codeFrequency(repo.name))),
    Promise.all(repos.map((repo) => languageBytes(repo.name))),
  ]);

  const commits = commitCounts.reduce((total, count) => total + count, 0);
  const additions = frequencies.reduce((total, repo) => total + repo.additions, 0);
  const deletions = frequencies.reduce((total, repo) => total + repo.deletions, 0);
  const languageBytesTotal = languageTotals.reduce((total, bytes) => total + bytes, 0);
  const codeTotal = additions + deletions || languageBytesTotal;

  return {
    repos: user.public_repos,
    contributed:
      contributionData?.user?.contributionsCollection?.contributionCalendar
        ?.totalContributions || 0,
    stars,
    commits,
    followers: user.followers,
    additions: additions || languageBytesTotal,
    deletions,
    lines: codeTotal,
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function textLine({ x, y, parts, size = 15 }) {
  const tspans = parts
    .map(
      (part) =>
        `<tspan fill="${part.color}">${escapeXml(part.text)}</tspan>`,
    )
    .join("");

  return `<text x="${x}" y="${y}" font-size="${size}">${tspans}</text>`;
}

function line(label, value, y) {
  return textLine({
    x: INFO_X,
    y,
    parts: [
      { text: ". ", color: COLORS.muted },
      { text: label, color: COLORS.label },
      { text: dotted(label, value), color: COLORS.muted },
      { text: value, color: COLORS.value },
    ],
  });
}

function dotted(label, value, target = 56) {
  const count = Math.max(3, target - label.length - value.length);
  return ` ${".".repeat(count)} `;
}

function section(title, y) {
  return textLine({
    x: INFO_X,
    y,
    parts: [
      { text: `- ${title} `, color: COLORS.fg },
      { text: "-".repeat(48 - title.length), color: COLORS.fg },
    ],
  });
}

function buildSvg(ascii, stats) {
  const asciiLines = ascii.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const art = asciiLines
    .map((line, index) =>
      textLine({
        x: 18,
        y: 48 + index * 15,
        size: 12,
        parts: [{ text: line, color: COLORS.fg }],
      }),
    )
    .join("\n");

  const rows = [
    textLine({
      x: INFO_X,
      y: 30,
      parts: [
        { text: `${USERNAME}@github `, color: COLORS.fg },
        { text: "-".repeat(44), color: COLORS.fg },
      ],
    }),
    line("OS:", "Windows, Android, Linux", 54),
    line("Uptime:", "22 years, 5 months, 29 days", 76),
    line("Host:", "Web Developer, UI/UX Builder", 98),
    line("Kernel:", "Web3, Blockchain, Real-World Apps", 120),
    line("IDE:", "VSCode, Figma, Adobe Creative Suite", 142),
    line("Languages.Programming:", "TypeScript, JavaScript", 186),
    line("Languages.Computer:", "HTML, CSS, JSON", 208),
    line("Languages.Real:", "English, Filipino", 230),
    line("Hobbies.Software:", "Web3, UI Design, App Building", 274),
    line("Hobbies.Hardware:", "Creative Workstations", 296),
    section("Contact", 340),
    line("LinkedIn:", "kurt-oswill", 364),
    line("GitHub:", USERNAME, 386),
    section("GitHub Stats", 430),
    textLine({
      x: INFO_X,
      y: 454,
      parts: [
        { text: ". ", color: COLORS.muted },
        { text: "Repos:", color: COLORS.label },
        { text: " .... ", color: COLORS.muted },
        { text: number(stats.repos), color: COLORS.value },
        { text: " {Contributed: ", color: COLORS.label },
        { text: number(stats.contributed), color: COLORS.value },
        { text: "} | ", color: COLORS.label },
        { text: "Stars:", color: COLORS.label },
        { text: " ............. ", color: COLORS.muted },
        { text: number(stats.stars), color: COLORS.value },
      ],
    }),
    textLine({
      x: INFO_X,
      y: 476,
      parts: [
        { text: ". ", color: COLORS.muted },
        { text: "Commits:", color: COLORS.label },
        { text: " ................... ", color: COLORS.muted },
        { text: number(stats.commits), color: COLORS.value },
        { text: " | ", color: COLORS.label },
        { text: "Followers:", color: COLORS.label },
        { text: " ........ ", color: COLORS.muted },
        { text: number(stats.followers), color: COLORS.value },
      ],
    }),
    textLine({
      x: INFO_X,
      y: 498,
      parts: [
        { text: ". ", color: COLORS.muted },
        { text: "Lines of Code on GitHub:", color: COLORS.label },
        { text: " . ", color: COLORS.muted },
        { text: number(stats.lines), color: COLORS.value },
        { text: " ( ", color: COLORS.fg },
        { text: `${number(stats.additions)}++`, color: COLORS.green },
        { text: ",  ", color: COLORS.fg },
        { text: `${number(stats.deletions)}--`, color: COLORS.red },
        { text: " )", color: COLORS.fg },
      ],
    }),
  ].join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="530" viewBox="0 0 1000 530" role="img" aria-label="${USERNAME} GitHub profile">
  <rect width="1000" height="530" rx="12" fill="${COLORS.bg}" stroke="${COLORS.border}" />
  <g font-family="Cascadia Mono, Consolas, Menlo, Monaco, monospace" xml:space="preserve">
${art}
${rows}
  </g>
</svg>
`;
}

async function main() {
  const [ascii, stats] = await Promise.all([
    fs.readFile(path.join(ROOT, "ascii-art.txt"), "utf8"),
    getStats(),
  ]);

  await fs.writeFile(path.join(ROOT, "profile.svg"), buildSvg(ascii, stats));
  await fs.writeFile(
    path.join(ROOT, "README.md"),
    `<p align="center">
  <img src="./profile.svg" alt="${USERNAME} terminal-style GitHub profile" />
</p>
`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
