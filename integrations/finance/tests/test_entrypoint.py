import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


class EntrypointTests(unittest.TestCase):
    def setUp(self):
        self.bash = shutil.which("bash")
        if not self.bash:
            self.skipTest("Bash is not installed")
        version = subprocess.check_output(
            [self.bash, "-c", "echo ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"], text=True
        ).strip()
        if tuple(map(int, version.split("."))) < (4, 3):
            self.skipTest("The entrypoint requires Bash 4.3+")
        self.temp = tempfile.TemporaryDirectory(prefix="finance entrypoint ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.module = self.root / "custom module"
        self.module.mkdir()
        self.script = self.module / "entrypoint.sh"
        shutil.copyfile(Path(__file__).parents[1] / "entrypoint.sh", self.script)
        self.stub = f"#!{sys.executable}\n" + '''import os, signal, sys, time
from pathlib import Path
role = "agent" if Path(sys.argv[0]).name == "opencode" else "worker"
events = Path(os.environ["TEST_EVENTS"])
def record(message):
    with events.open("a") as output:
        output.write(message + "\\n")
def stop(*args):
    record(role + ":stopped")
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
record(role + ":started:" + "|".join(sys.argv[1:]))
if os.environ.get("TEST_EXIT_ROLE") == role:
    # Let both children install their signal handlers before one exits.
    for _ in range(500):
        if "agent:started:" in events.read_text() and "worker:started:" in events.read_text():
            break
        time.sleep(0.01)
    sys.exit(7)
while True:
    time.sleep(0.01)
'''
        self.python = self.module / ".venv" / "bin" / "python"
        self.python.parent.mkdir(parents=True)
        self.executable(self.python)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.executable(self.bin / "opencode")
        self.events = self.root / "events"
        self.env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "FINANCE_CONFIG": str(self.root / "config.json"), "TEST_EVENTS": str(self.events)}
        self.env.pop("FINANCE_PYTHON", None)

    def executable(self, path):
        path.write_text(self.stub)
        path.chmod(0o755)

    def start(self, **env):
        process = subprocess.Popen(
            [self.bash, str(self.script), "serve", "--port", "4096"], cwd=self.root,
            env={**self.env, **env}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        def cleanup():
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
        self.addCleanup(cleanup)
        return process

    def test_relocated_module_uses_adjacent_venv_and_stops_peer_on_exit(self):
        for role in ("worker", "agent"):
            with self.subTest(role=role):
                self.events.unlink(missing_ok=True)
                process = self.start(TEST_EXIT_ROLE=role)
                _, errors = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 7, errors)
                events = self.events.read_text()
                self.assertIn(f"worker:started:{self.module / 'finance.py'}|worker", events)
                self.assertIn("agent:started:serve|--port|4096", events)
                peer = "agent" if role == "worker" else "worker"
                self.assertIn(peer + ":stopped", events)

    def test_custom_python_and_termination_stop_both_children(self):
        self.python.unlink()
        custom_python = self.root / "custom python"
        self.executable(custom_python)
        process = self.start(FINANCE_PYTHON=str(custom_python))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            events = self.events.read_text() if self.events.exists() else ""
            if "worker:started:" in events and "agent:started:" in events:
                break
            if process.poll() is not None:
                self.fail(process.communicate()[1])
            time.sleep(0.01)
        else:
            self.fail("Children did not start")
        process.terminate()
        _, errors = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, errors)
        events = self.events.read_text()
        self.assertIn("worker:stopped", events)
        self.assertIn("agent:stopped", events)

    def test_missing_config_or_python_fails_before_starting_agent(self):
        for env, message in (({"FINANCE_CONFIG": ""}, "FINANCE_CONFIG"),
                             ({"FINANCE_PYTHON": str(self.root / "missing")}, "FINANCE_PYTHON")):
            with self.subTest(env=env):
                process = self.start(**env)
                _, errors = process.communicate(timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn(message, errors)
                self.assertFalse(self.events.exists())
