"""轻量 TensorBoard 事件文件解析（无 tensorflow 依赖）。

支持 tensorboardX SummaryWriter.add_scalar 写出的旧式 simple_value 标量，
这正是 playground/common/runner.py 中使用的方式。
"""

import struct
from pathlib import Path


def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7


def _iter_tfrecord(data: bytes):
    """迭代 TFRecord 帧，yield payload bytes。跳过 CRC 校验。"""
    pos = 0
    n = len(data)
    while pos + 12 <= n:
        (length,) = struct.unpack_from("<Q", data, pos)
        pos += 8 + 4  # length + length_crc
        if length == 0 or pos + length + 4 > n:
            break
        yield data[pos : pos + length]
        pos += length + 4  # payload + data_crc


def _parse_value(v: bytes) -> tuple[str | None, float | None]:
    """Summary.Value: field1=tag(string) field2=simple_value(float)。"""
    tag = None
    simple = None
    pos = 0
    n = len(v)
    while pos < n:
        t, pos = _read_varint(v, pos)
        fnum, wire = t >> 3, t & 7
        if wire == 0:
            _, pos = _read_varint(v, pos)
        elif wire == 1:
            pos += 8
        elif wire == 2:
            ln, pos = _read_varint(v, pos)
            if fnum == 1:
                tag = v[pos : pos + ln].decode("utf-8", errors="replace")
            pos += ln
        elif wire == 5:
            if fnum == 2:
                (simple,) = struct.unpack_from("<f", v, pos)
            pos += 4
    return tag, simple


def _parse_summary(sub: bytes) -> list[tuple[str | None, float | None]]:
    values: list[tuple[str | None, float | None]] = []
    pos = 0
    n = len(sub)
    while pos < n:
        t, pos = _read_varint(sub, pos)
        wire = t & 7
        if wire == 2:
            ln, pos = _read_varint(sub, pos)
            if t >> 3 == 1:  # repeated Value value
                values.append(_parse_value(sub[pos : pos + ln]))
            pos += ln
        elif wire == 0:
            _, pos = _read_varint(sub, pos)
        elif wire == 1:
            pos += 8
        elif wire == 5:
            pos += 4
    return values


def _parse_event(payload: bytes):
    """Event: field1=wall_time(double) field2=step(int64) field3=summary。"""
    wall_time = 0.0
    step = 0
    values: list[tuple[str | None, float | None]] = []
    pos = 0
    n = len(payload)
    while pos < n:
        t, pos = _read_varint(payload, pos)
        fnum, wire = t >> 3, t & 7
        if wire == 0:
            val, pos = _read_varint(payload, pos)
            if fnum == 2:
                step = val
        elif wire == 1:
            if fnum == 1:
                (wall_time,) = struct.unpack_from("<d", payload, pos)
            pos += 8
        elif wire == 2:
            ln, pos = _read_varint(payload, pos)
            # 新版 Event proto 中 Summary 位于 field 5（field 3 是 file_version）
            if fnum == 5:
                values = _parse_summary(payload[pos : pos + ln])
            pos += ln
        elif wire == 5:
            pos += 4
    return wall_time, step, values


def read_scalars(log_dir: Path) -> dict[str, dict[str, list]]:
    """读取目录下所有 events.out.tfevents.* 文件，返回 {tag: {steps: [], values: []}}。"""
    series: dict[str, dict[str, list]] = {}
    if not log_dir.is_dir():
        return series
    for f in sorted(log_dir.glob("events.out.tfevents.*")):
        try:
            data = f.read_bytes()
        except OSError:
            continue
        for payload in _iter_tfrecord(data):
            try:
                _, step, values = _parse_event(payload)
            except (IndexError, struct.error):
                continue
            for tag, simple in values:
                if tag is None or simple is None:
                    continue
                s = series.setdefault(tag, {"steps": [], "values": []})
                s["steps"].append(step)
                s["values"].append(simple)
    for s in series.values():
        pairs = sorted(zip(s["steps"], s["values"]), key=lambda x: x[0])
        s["steps"] = [p[0] for p in pairs]
        s["values"] = [p[1] for p in pairs]
    return series
