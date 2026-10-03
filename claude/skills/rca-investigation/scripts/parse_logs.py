#!/usr/bin/env python3
"""Stream explicit IIS W3C, CSV or HAProxy HTTP formats as traceable JSONL."""
import argparse
import csv
import datetime as dt
import json
import re
import sys
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = dt.timezone.utc
MONTHS = {m: i + 1 for i, m in enumerate('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split())}
HAP = re.compile(r'(?P<client>\S+) \[(?P<time>[^]]+)\] (?P<frontend>\S+) (?P<backend>\S+) (?P<timings>[+\d-]+/[+\d-]+/[+\d-]+/[+\d-]+/[+\d-]+) (?P<status>\d{3}) (?P<bytes>\+?\d+) (?P<rest>.*)$')


def normalize(raw, fmt=None, timezone=None, haproxy=False):
    """Return UTC only with explicit offset or caller-established zone; detect DST."""
    try:
        if haproxy:
            match = re.fullmatch(r'(\d{2})/([A-Za-z]{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?', raw)
            if not match:
                raise ValueError()
            day, month, year, hour, minute, second, fraction = match.groups()
            value = dt.datetime(int(year), MONTHS[month], int(day), int(hour), int(minute), int(second), int((fraction or '.0')[1:].ljust(6, '0')))
        else:
            value = dt.datetime.strptime(raw, fmt) if fmt else dt.datetime.fromisoformat(raw.replace('Z', '+00:00'))
        if value.tzinfo is not None:
            return value.astimezone(UTC).isoformat(), 'explicit_offset'
        if not timezone:
            return None, 'timezone_unknown'
        zone = ZoneInfo(timezone)
        candidates = set()
        for fold in (0, 1):
            aware = value.replace(tzinfo=zone, fold=fold)
            utc = aware.astimezone(UTC)
            if utc.astimezone(zone).replace(tzinfo=None) == value:
                candidates.add(utc)
        if not candidates:
            return None, 'nonexistent_local_time'
        if len(candidates) != 1:
            return None, 'ambiguous_local_time'
        return candidates.pop().isoformat(), 'declared_timezone'
    except (ValueError, KeyError, OverflowError):
        return None, 'timestamp_invalid'


def records(stream, args):
    """Yield start/end physical lines, fields, timestamp or bounded error code."""
    if args.format == 'csv':
        reader = csv.reader(stream, delimiter=args.delimiter, strict=True)
        header = next(reader, None)
        if header is None:
            return
        if len(set(header)) != len(header) or args.timestamp_column not in header:
            yield 1, reader.line_num, None, None, 'invalid_csv_header'
            return
        previous = reader.line_num
        try:
            for row in reader:
                start, end = previous + 1, reader.line_num
                previous = end
                if not row:
                    continue
                if len(row) != len(header):
                    yield start, end, None, None, 'column_count_mismatch'
                    continue
                fields = dict(zip(header, row))
                yield start, end, fields, fields[args.timestamp_column], None
        except csv.Error:
            yield previous + 1, reader.line_num, None, None, 'malformed_csv'
        return
    header = None
    for number, line in enumerate(stream, 1):
        line = line.rstrip('\r\n')
        if not line:
            continue
        if args.format == 'iis':
            if line.startswith('#Fields:'):
                header = line[len('#Fields:'):].split()
                if len(set(header)) != len(header) or not {'date', 'time'}.issubset(header):
                    header = None
                    yield number, number, None, None, 'invalid_iis_header'
                continue
            if line.startswith('#'):
                continue
            if header is None:
                yield number, number, None, None, 'missing_iis_header'
                continue
            values = line.split()
            if len(values) != len(header):
                yield number, number, None, None, 'column_count_mismatch'
                continue
            fields = dict(zip(header, values))
            yield number, number, fields, fields['date'] + 'T' + fields['time'], None
        else:
            match = HAP.search(line)
            if not match:
                yield number, number, None, None, 'unsupported_haproxy_line'
                continue
            fields = match.groupdict()
            raw = fields.pop('time')
            names = ('Tq', 'Tw', 'Tc', 'Tr', 'Tt') if args.haproxy_timing == 'legacy' else ('TR', 'Tw', 'Tc', 'Tr', 'Ta')
            fields['timings_ms_raw'] = dict(zip(names, fields.pop('timings').split('/')))
            fields['timing_mode'] = args.haproxy_timing
            yield number, number, fields, raw, None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--source-id', required=True)
    parser.add_argument('--format', choices=('iis', 'csv', 'haproxy'), required=True)
    parser.add_argument('--timezone', help='Verified IANA timezone, e.g. UTC or Europe/Lisbon; never inferred')
    parser.add_argument('--timestamp-format', help='CSV strptime format; default ISO 8601')
    parser.add_argument('--timestamp-column', help='Exact CSV column name; no vendor schema inferred')
    parser.add_argument('--delimiter', default=',')
    parser.add_argument('--haproxy-timing', choices=('legacy', 'modern'), help='Required for HAProxy; establish from log-format configuration')
    parser.add_argument('--encoding', default='utf-8-sig')
    args = parser.parse_args(argv)
    if args.format == 'csv' and not args.timestamp_column:
        parser.error('CSV requires --timestamp-column')
    if args.format == 'haproxy' and not args.haproxy_timing:
        parser.error('HAProxy requires --haproxy-timing')
    if len(args.delimiter) != 1:
        parser.error('delimiter must be one character')
    if args.timezone:
        try:
            ZoneInfo(args.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            parser.error('timezone is unavailable or invalid')
    counts = Counter()
    errors = Counter()
    try:
        with args.source.open(encoding=args.encoding, errors='strict', newline='') as stream:
            for start, end, fields, raw, error in records(stream, args):
                counts['records_seen'] += 1
                if error:
                    errors[error] += 1
                    print(json.dumps({'event': 'rejected', 'source_id': args.source_id, 'line_start': start, 'line_end': end, 'reason': error}), file=sys.stderr)
                    continue
                utc, status = normalize(raw, args.timestamp_format if args.format == 'csv' else None, args.timezone, args.format == 'haproxy')
                counts['emitted'] += 1
                counts[status] += 1
                print(json.dumps({'source_id': args.source_id, 'source': str(args.source.resolve()), 'line_start': start, 'line_end': end, 'timestamp_raw': raw, 'timestamp_utc': utc, 'time_status': status, 'declared_timezone': args.timezone, 'fields': fields}, ensure_ascii=False))
    except (OSError, UnicodeError, LookupError, csv.Error):
        errors['source_read_failed'] += 1
    normalized = counts['explicit_offset'] + counts['declared_timezone']
    print(json.dumps({'event': 'summary', 'source_id': args.source_id, 'counts': dict(counts), 'errors': dict(errors), 'extraction_complete': not bool(errors), 'emitted_records_time_complete': normalized == counts['emitted'], 'emitted_records_with_utc': normalized}), file=sys.stderr)
    return 2 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
