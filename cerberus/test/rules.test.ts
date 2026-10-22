/**
 * Self-check for rules.ts: every seed is a hit, the listed counterexamples are
 * misses, and quoting / pipes / `&&` are split before any decision is made.
 *
 *   node cerberus/test/rules.test.ts
 */
import assert from "node:assert/strict";
import { isBackgrounded, needsLongRun, splitCommands } from "../rules.ts";

const HITS: Array<[string, string]> = [
  ["sleep >= 15", "sleep 15"],
  ["sleep minutes", "sleep 2m"],
  ["sleep sum", "sleep 10 5"],
  ["tail -f", "tail -f app.log"],
  ["tail -F", "tail -n 20 -F /var/log/syslog"],
  ["tail --follow", "tail --follow=name app.log"],
  ["journalctl -f", "journalctl -f"],
  ["journalctl --follow", "journalctl --follow -u nginx"],
  ["watch", "watch -n 1 date"],
  ["ping without count", "ping example.com"],
  ["npm install", "npm install"],
  ["npm ci", "npm ci"],
  ["npm run build", "npm run build"],
  ["npm test", "npm test"],
  ["npm start", "npm start"],
  ["npm run dev", "npm run dev"],
  ["yarn build", "yarn build"],
  ["pnpm install", "pnpm install"],
  ["bun install", "bun install"],
  ["cargo build", "cargo build --release"],
  ["cargo test", "cargo test"],
  ["cargo run", "cargo run"],
  ["cargo watch", "cargo watch -x test"],
  ["go build", "go build ./..."],
  ["go test", "go test ./..."],
  ["go run", "go run ."],
  ["make", "make"],
  ["cmake --build", "cmake --build build"],
  ["pytest", "pytest -q"],
  ["jest", "jest"],
  ["vitest", "vitest run"],
  ["playwright", "playwright test"],
  ["docker build", "docker build ."],
  ["docker run", "docker run --rm image"],
  ["docker compose", "docker compose up"],
  ["kubectl wait", "kubectl wait --for=condition=Ready pod/x"],
  ["kubectl rollout", "kubectl rollout status deploy/x"],
  ["git clone", "git clone https://example.com/x.git"],
  ["git fetch", "git fetch origin"],
  ["git pull", "git pull"],
  ["git push", "git push"],
  ["git lfs", "git lfs pull"],
  ["pip install", "pip install requests"],
  ["pip3 install", "pip3 install requests"],
  ["poetry install", "poetry install"],
  ["uv pip install", "uv pip install requests"],
  ["mvn", "mvn package"],
  ["gradle", "gradle build"],
  ["gradlew", "./gradlew build"],
  ["rsync", "rsync -a src/ dest/"],
  ["scp", "scp file host:/tmp"],
  ["ssh with remote command", "ssh host 'systemctl restart nginx'"],
  ["terraform apply", "terraform apply -auto-approve"],
  // `timeout` is a wrapper, not an exemption.
  ["timeout wrapper", "timeout 600 npm run build"],
  ["timeout signal flag", "timeout --signal=KILL 60 pytest"],
  ["timeout value flags", "timeout -s KILL -k 5s 60 pytest"],
  ["timeout preserve status", "timeout --preserve-status 60 npm test"],
  ["timeout around shell", `timeout 5 bash -c 'npm test'`],
  ["timeout after keyword", "then timeout 60 npm test"],
  // Leading shell syntax.
  ["if/then/fi", "if [ -f x ]; then npm run build; fi"],
  ["for/do/done", "for d in a b; do npm run build; done"],
  ["while/do/done", "while true; do npm test; done"],
  ["negation", "! npm test"],
  ["brace group", "{ npm run build; }"],
  // nohup/setsid only wrap; they still run in the foreground without `&`.
  ["nohup without ampersand", "nohup npm start > out.log 2>&1"],
  ["setsid without fork", "setsid npm start"],
  ["setsid --fork", "setsid --fork npm start"],
  // Compound lines: one long simple command is enough.
  ["compound &&", "cd /tmp && npm install"],
  ["compound ;", "echo start; sleep 30"],
  ["pipeline", "cat log | tail -f"],
  // Wrappers are unwrapped.
  ["sudo", "sudo npm test"],
  ["sudo with value flag", "sudo -u root npm test"],
  ["env assignment", "env CI=1 npm run build"],
  ["command", "command npm test"],
  ["time", "time npm test"],
  ["nice", "nice -n 5 npm test"],
  ["stdbuf", "stdbuf -oL npm test"],
  ["nohup", "nohup npm test"],
  ["setsid", "setsid npm test"],
  ["exec", "exec npm test"],
  ["xargs", "xargs -n1 npm install"],
  // Subshell / grouping.
  ["subshell", "(cd repo && npm build)"],
  ["group after ;", "echo x; (npm test)"],
  // Shell -c bodies, including compact flags.
  ["bash -c", `bash -c 'npm run build'`],
  ["sh -c", `sh -c "docker build ."`],
  ["zsh -lc", `zsh -lc 'sleep 20'`],
  ["dash -c", `dash -c 'git push'`],
  ["eval", `eval 'pytest -q'`],
  ["nested shell", `bash -c "bash -c 'sleep 30'"`],
];

for (const [label, command] of HITS) {
  assert.equal(needsLongRun(command), true, `should hit: ${label}: ${command}`);
}

const MISSES: Array<[string, string]> = [
  ["quoted sleep", `echo "sleep 600"`],
  ["quoted npm", `grep 'npm run build' log`],
  ["timeout non-long command", "timeout 600 grep foo bar"],
  ["timeout without command", "timeout 600"],
  ["timeout backgrounded", "timeout 600 npm test &"],
  ["if body is harmless", "if [ -f x ]; then echo ok; fi"],
  ["backgrounded npm", "npm test &"],
  ["backgrounded nohup", "nohup npm test &"],
  ["grep", "grep sleep file"],
  ["find", "find . -name '*.ts'"],
  ["ls", "ls -la"],
  ["cat", "cat file"],
  ["shell body that is harmless", `bash -c 'echo "sleep 600"'`],
  ["shell body with quotes", `bash -c "echo 'npm run build'"`],
  ["-c after a script name is an argument", `bash script.sh -c 'sleep 600'`],
  ["short sleep", "sleep 5"],
  ["short sleep sum", "sleep 5 9"],
  ["fractional short sleep", "sleep 0.5"],
  ["ping with count", "ping -c 3 example.com"],
  ["npm script listing", "npm run"],
  ["make --version", "make --version"],
  ["ssh without remote command", "ssh host"],
  ["echo with quoted separator", `echo "a && npm install"`],
  ["echo with quoted semicolon", `echo 'a; b'`],
  ["unknown command", "true"],
];

for (const [label, command] of MISSES) {
  assert.equal(needsLongRun(command), false, `should miss: ${label}: ${command}`);
}

// --- splitting ------------------------------------------------------------
{
  const commands = splitCommands(`a && b || c | d; e\necho 'x;y' "x & y"`);
  assert.deepEqual(
    commands.map((command) => command.argv),
    [["a"], ["b"], ["c"], ["d"], ["e"], ["echo", "x;y", "x & y"]],
  );
  assert.deepEqual(
    commands.map((command) => command.background),
    [false, false, false, false, false, false],
  );

  const background = splitCommands("npm test & echo done");
  assert.deepEqual(background[0], { argv: ["npm", "test"], background: true });
  assert.equal(background[1].background, false);

  // Redirections are not background operators.
  assert.equal(isBackgrounded("cmd 2>&1"), false);
  assert.equal(isBackgrounded("cmd &> out.log"), false);
  assert.equal(isBackgrounded("cmd > out.log &"), true);

  // Quotes hide both `&` and the wrapper.
  assert.equal(isBackgrounded(`echo "&"`), false);
  assert.equal(isBackgrounded("nohup npm test"), false);
  assert.equal(isBackgrounded("nohup npm test > out.log 2>&1"), false);
  assert.equal(isBackgrounded("setsid npm test"), false);
  assert.equal(isBackgrounded("setsid --fork npm test"), true);
  assert.equal(isBackgrounded("setsid -f npm test"), true);
  assert.equal(isBackgrounded("env CI=1 nohup npm test"), false);
  assert.equal(isBackgrounded("nohup npm test &"), true);
  assert.equal(isBackgrounded("echo nohup"), false);
  assert.equal(isBackgrounded("(npm test) &"), true);
  // needsLongRun still sees through the wrapper that is not a detach.
  assert.equal(needsLongRun("nohup npm start > out.log 2>&1"), true);
  assert.equal(needsLongRun("setsid npm start"), true);
  assert.equal(needsLongRun("setsid --fork npm start"), true);
}

console.log("rules.test.ts: ok");
