# Security policy

## Supported versions

| Version | Supported                |
| ------- | ------------------------ |
| 0.1.x   | Yes                      |
| 0.0.x   | No, upgrade to 0.1.x     |

Send a report and you get a fix in the next release. There is no separate security channel and no
embargo process.

## Report privately

Open a private report at
[github.com/Barty13/pi-wake-jobs/security/advisories/new](https://github.com/Barty13/pi-wake-jobs/security/advisories/new).
Do not open a public issue for a vulnerability. Public issues are for bugs and feature requests.

Include:

- The version from `package.json` and the commit you ran.
- What happens now, and what you expected.
- Steps another person can repeat, with the command lines.
- Whether your own files, processes, or logs are involved.

## What this extension does on your machine

Read this before you call something a vulnerability. Much of the surface below is the design.

- It runs the command you or the agent gives it, as your user, with your permissions. It asks for
  no approval and shows no prompt. An agent that starts a wrong command runs a wrong command.
- It makes no network request of its own. It opens no port and downloads nothing. The Pi process you
  already use still talks to its model provider, that is outside this extension.
- It writes job output to `$TMPDIR/pi-jobs`. The directory and the log files take the modes your
  umask gives. Under the common umask `0022` that is `drwxr-xr-x` and `-rw-r--r--`, so any other
  account on the machine can read every job log. On your own laptop that means nothing. On a shared
  host it is a leak: point `PI_JOBS_DIR` at a directory only you can read, or start Pi under umask
  `0077`.
- It writes job records into the Pi transcript file, in your project directory or in
  `$PI_CODING_AGENT_DIR/projects`. The record repeats the command line and the log path.

## Limits by design, not vulnerabilities

- **No secret redaction.** A command line with a token in it is written to the log and the durable
  transcript entry unchanged. Put the secret in an environment variable or a file, not in the
  command.
- **No approval.** Commands run without a prompt. That is the point of the tool, and it is the same
  trust level Pi already gives to its `bash` tool.
- **Process group signals.** `job_stop` and session shutdown send `SIGTERM` to the whole process
  group of a job, then `SIGKILL` after two seconds. A command that re-parents its children can keep
  running. This is the same limit any `setsid` style supervisor has.
- **Pruning deletes files.** At session start it removes old files in `$PI_JOBS_DIR` whose owner
  process is gone. It only removes names it wrote, `j<number>-<pid>.log`. Do not keep work you care
  about in that directory.

## If you point the tool at someone else's data

Pi records the job in the Pi transcript, not in the job log. Treat the transcript as a file with
secrets in it when you share a session, paste a log path, or commit a project directory.
