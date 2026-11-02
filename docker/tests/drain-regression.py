"""Exercise the real drain helpers with only explicitly owned workload PIDs.

Never execute the production all-process scan on the host. PTYs and /proc
signal masks are real; only workload discovery is replaced with a fixed list.
"""
import fcntl
import os
from pathlib import Path
import pty
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
DRAIN = (ROOT / 'docker/orkestrator-drain.sh').read_text()


class DrainRegression(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.children = []
        self.terminals = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()  # Popen handle belongs to this test only.
            child.wait()
        for fd in self.terminals:
            os.close(fd)
        self.temp.cleanup()

    def spawn(self, code, terminal=False, stdin=None):
        ready = self.directory / str(len(self.children))
        def session():
            os.setsid()
            if terminal:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        if terminal:
            master, slave = pty.openpty()
            self.terminals.extend([master, slave])
            stdin = slave
        child = subprocess.Popen([sys.executable, '-c', code, str(ready)],
                                 stdin=stdin or subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 preexec_fn=session)
        self.children.append(child)
        deadline = time.monotonic() + 5
        while not ready.exists():
            if child.poll() is not None:
                self.fail(child.stderr.read().decode())
            if time.monotonic() > deadline:
                self.fail('child readiness timeout')
            time.sleep(.01)
        return child

    def drain(self, grace=4):
        # Source definitions without running main; override discovery before
        # executing its unchanged signal/wait/report logic.
        helpers, main = DRAIN.split('\nsignalled=0\n', 1)
        pids = ' '.join(str(child.pid) for child in self.children)
        override = '''
workload_pids() {
    local pid stat
    for pid in ''' + pids + '''; do
        stat="$(cat /proc/$pid/stat 2>/dev/null)" || continue
        set -- ${stat##*) }
        [ "$1" = Z ] || echo "$pid"
    done
}
'''
        start = time.monotonic()
        result = subprocess.run(['bash', '-c', helpers + override + '\nsignalled=0\n' + main,
                                 'drain-test', str(grace)], capture_output=True, timeout=grace+5)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return time.monotonic()-start, result.stdout.decode()

    def test_delayed_cleanup_precedes_terminal_hangup_and_resumes_stopped_job(self):
        child = self.spawn('''import os, signal, sys, time
from pathlib import Path
def term(*_):
    time.sleep(1.2)
    Path(sys.argv[1] + '-done').touch()
    sys.exit(0)
signal.signal(signal.SIGTERM, term)
Path(sys.argv[1]).touch()
os.kill(os.getpid(), signal.SIGSTOP)
while True: time.sleep(.01)
''', terminal=True)
        done = self.directory / '0-done'
        shell = self.spawn('''import signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
def hup(*_):
    sys.exit(0 if Path(sys.argv[1]).with_name('0-done').exists() else 3)
signal.signal(signal.SIGHUP, hup)
Path(sys.argv[1]).touch()
while True: time.sleep(.01)
''', terminal=True)
        elapsed, report = self.drain()
        self.assertTrue(done.exists())
        self.assertEqual(child.wait(timeout=1), 0)
        self.assertEqual(shell.wait(timeout=1), 0)
        self.assertGreater(elapsed, 1.2)
        self.assertLess(elapsed, 3.5)
        self.assertIn('remaining=0 hungup=1', report)

    def test_delayed_eof_reader_flushes_final_partial_record(self):
        producer = self.spawn('''import signal, sys, time
from pathlib import Path
def term(*_):
    print('final partial', end='', flush=True)
    sys.exit(0)
signal.signal(signal.SIGTERM, term)
Path(sys.argv[1]).touch()
while True: time.sleep(.01)
''')
        output = self.directory / 'log'
        self.spawn('''import signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
Path(sys.argv[1]).touch()
record = sys.stdin.read()
time.sleep(1.2)
Path(sys.argv[1]).with_name('log').write_text(record)
''', stdin=producer.stdout)
        producer.stdout.close()
        elapsed, report = self.drain()
        self.assertEqual(output.read_text(), 'final partial')
        self.assertGreater(elapsed, 1.2)
        self.assertIn('remaining=0', report)

    def test_image_writer_drains_terminal_producer_after_hangup(self):
        producer = self.spawn('''import signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
def hup(*_):
    print('terminal final partial', end='', flush=True)
    sys.exit(0)
signal.signal(signal.SIGHUP, hup)
Path(sys.argv[1]).touch()
while True: time.sleep(.01)
''', terminal=True)
        writer = self.spawn('''import os, signal, sys
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
Path(sys.argv[1]).touch()
os.execv('/bin/bash', ['bash', sys.argv[2], sys.argv[3]])
'''.replace("sys.argv[2]", repr(str(ROOT / 'docker/orkestrator-log-writer.sh')))
           .replace("sys.argv[3]", repr(str(self.directory / 'writer.log'))),
           stdin=producer.stdout)
        producer.stdout.close()
        elapsed, report = self.drain()
        self.assertEqual(writer.wait(timeout=1), 0)
        self.assertEqual((self.directory / 'writer.log').read_text(),
                         'terminal final partial\n')
        self.assertLess(elapsed, 3)
        self.assertIn('remaining=0 hungup=1', report)

    def test_term_and_hup_ignorers_are_reported_without_waiting(self):
        code = '''import signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
Path(sys.argv[1]).touch()
while True: time.sleep(.01)
'''
        self.spawn(code, terminal=True)
        self.spawn(code)
        elapsed, report = self.drain()
        self.assertLess(elapsed, 2)
        self.assertIn('remaining=2 hungup=0', report)

    def test_pipe_reader_still_obeys_shared_deadline(self):
        read_fd, write_fd = os.pipe()
        try:
            self.spawn('''import signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
Path(sys.argv[1]).touch()
sys.stdin.read()
''', stdin=read_fd)
            elapsed, report = self.drain(1)
            self.assertGreaterEqual(elapsed, 1)
            self.assertLess(elapsed, 2.5)
            self.assertIn('remaining=1', report)
        finally:
            os.close(read_fd)
            os.close(write_fd)


if __name__ == '__main__':
    unittest.main()
