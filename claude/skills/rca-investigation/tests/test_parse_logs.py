import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('parse_logs', Path(__file__).resolve().parents[1] / 'scripts' / 'parse_logs.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class LogsTest(unittest.TestCase):
    def args(self, **kw):
        defaults = dict(format='iis', delimiter=',', timestamp_column='when', haproxy_timing='modern')
        defaults.update(kw)
        return argparse.Namespace(**defaults)

    def test_iis_changed_headers_and_bad_rows(self):
        rows = list(m.records(io.StringIO('#Fields: date time sc-status\n2026-09-16 12:00:00 200\n#Fields: sc-status time date\n503 12:01:00 2026-09-16\nbad\n'), self.args()))
        self.assertEqual(rows[1][2]['sc-status'], '503')
        self.assertEqual(rows[1][0], 4)
        self.assertEqual(rows[2][-1], 'column_count_mismatch')

    def test_csv_multiline_provenance(self):
        rows = list(m.records(io.StringIO('when,message\n2026-09-16T10:00:00Z,"hello\nworld"\n'), self.args(format='csv')))
        self.assertEqual(rows[0][:2], (2, 3))
        self.assertEqual(rows[0][2]['message'], 'hello\nworld')

    def test_csv_duplicate_header_rejected(self):
        rows = list(m.records(io.StringIO('when,when\na,b\n'), self.args(format='csv')))
        self.assertEqual(rows[0][-1], 'invalid_csv_header')

    def test_time_uncertainty(self):
        self.assertEqual(m.normalize('2026-09-16T10:00:00')[1], 'timezone_unknown')
        self.assertEqual(m.normalize('2026-10-25T01:30:00', timezone='Europe/Lisbon')[1], 'ambiguous_local_time')
        self.assertEqual(m.normalize('2026-03-29T01:30:00', timezone='Europe/Lisbon')[1], 'nonexistent_local_time')
        self.assertEqual(m.normalize('2026-09-16T10:00:00', timezone='Europe/Lisbon')[0], '2026-09-16T09:00:00+00:00')
        self.assertEqual(m.normalize('2026-09-16T10:00:00+02:00')[0], '2026-09-16T08:00:00+00:00')

    def test_haproxy_timing_modes_and_raw_sentinels(self):
        line = 'syslog prefix haproxy[4]: 10.0.0.1:123 [16/Sep/2026:10:00:00.123] fe be/srv 0/1/-1/-1/+20 503 0 - - SC-- 1/1/1/1/0 0/0 "GET / HTTP/1.1"\n'
        for mode, first, last in [('legacy', 'Tq', 'Tt'), ('modern', 'TR', 'Ta')]:
            row = list(m.records(io.StringIO(line), self.args(format='haproxy', haproxy_timing=mode)))[0]
            self.assertEqual(row[2]['timings_ms_raw'][last], '+20')
            self.assertEqual(row[2]['timings_ms_raw'][first], '0')
            self.assertEqual(row[2]['timings_ms_raw']['Tc'], '-1')
            self.assertEqual(m.normalize(row[3], timezone='UTC', haproxy=True)[0], '2026-09-16T10:00:00.123000+00:00')

    def test_cli_errors_do_not_echo_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'synthetic.log'
            original = '#Fields: date time\nSECRET REJECTED EXTRA\n2026-09-16 10:00:00\n'
            path.write_text(original)
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = m.main([str(path), '--source-id', 'S1', '--format', 'iis', '--timezone', 'UTC'])
            self.assertEqual(code, 2)
            self.assertNotIn('SECRET', err.getvalue())
            self.assertEqual(json.loads(out.getvalue())['line_start'], 3)
            self.assertEqual(path.read_text(), original)

    def test_cli_empty_and_malformed_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'synthetic.csv'
            for content, code in [('', 0), ('"unterminated', 2)]:
                path.write_text(content)
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    actual = m.main([str(path), '--source-id', 'S1', '--format', 'csv', '--timestamp-column', 'when'])
                self.assertEqual(actual, code)
                summary = json.loads(err.getvalue().splitlines()[-1])
                self.assertEqual(summary['source_id'], 'S1')
                self.assertEqual(summary['extraction_complete'], code == 0)


if __name__ == '__main__':
    unittest.main()
