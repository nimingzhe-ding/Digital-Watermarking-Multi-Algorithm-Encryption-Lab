import argparse
import base64
import json
import math
import sys
import zlib
from pathlib import Path

from PIL import Image


HEADER_MAGIC = b"IWM1"
VERSION = 1
HEADER_SIZE = 16
HEADER_BITS = HEADER_SIZE * 8
CHANNEL_CODES = {
    "blue": 1,
    "green": 2,
    "red": 3,
    "rgb": 4,
}
CODE_TO_CHANNEL = {value: key for key, value in CHANNEL_CODES.items()}
CHANNEL_INDEXES = {
    "blue": (2,),
    "green": (1,),
    "red": (0,),
    "rgb": (0, 1, 2),
}


class WatermarkError(Exception):
    pass


def open_rgba_image(path_str):
    path = Path(path_str)
    image = Image.open(path)
    rgba = image.convert("RGBA")
    return rgba, bytearray(rgba.tobytes())


def bytes_to_bits(data):
    for value in data:
        for shift in range(7, -1, -1):
            yield (value >> shift) & 1


def bits_to_bytes(bits):
    output = bytearray()
    for offset in range(0, len(bits), 8):
        chunk = bits[offset : offset + 8]
        value = 0
        for bit in chunk:
            value = (value << 1) | bit
        output.append(value)
    return bytes(output)


def build_header(channel_mode, repetition, payload_bytes):
    payload_length = len(payload_bytes)
    checksum = zlib.crc32(payload_bytes) & 0xFFFFFFFF
    return (
        HEADER_MAGIC
        + bytes(
            [
                VERSION,
                CHANNEL_CODES[channel_mode],
                repetition,
                0,
            ]
        )
        + payload_length.to_bytes(4, "big")
        + checksum.to_bytes(4, "big")
    )


def parse_header(header_bytes):
    if len(header_bytes) != HEADER_SIZE:
        raise WatermarkError("水印头长度不正确")

    if header_bytes[:4] != HEADER_MAGIC:
        raise WatermarkError("未检测到支持的不可见水印头")

    version = header_bytes[4]
    channel_code = header_bytes[5]
    repetition = header_bytes[6]

    if version != VERSION:
        raise WatermarkError("水印版本不兼容")

    if channel_code not in CODE_TO_CHANNEL:
        raise WatermarkError("水印通道模式无法识别")

    if repetition not in (1, 3, 5):
        raise WatermarkError("水印鲁棒模式无法识别")

    return {
        "channel_mode": CODE_TO_CHANNEL[channel_code],
        "repetition": repetition,
        "payload_length": int.from_bytes(header_bytes[8:12], "big"),
        "checksum": int.from_bytes(header_bytes[12:16], "big"),
    }


def iter_body_positions(pixel_count, channel_mode):
    channels = CHANNEL_INDEXES[channel_mode]
    for pixel_index in range(pixel_count):
        base = pixel_index * 4
        for channel_index in channels:
            if channel_index == 2 and pixel_index < HEADER_BITS:
                continue
            yield base + channel_index


def compute_capacity_bytes(pixel_count, channel_mode, repetition):
    if pixel_count < HEADER_BITS:
        return 0

    positions_per_pixel = len(CHANNEL_INDEXES[channel_mode])
    usable_bits = pixel_count * positions_per_pixel

    if channel_mode == "rgb":
        usable_bits -= HEADER_BITS
    elif channel_mode == "blue":
        usable_bits -= HEADER_BITS

    usable_bits = max(0, usable_bits)
    logical_bits = usable_bits // repetition

    return logical_bits // 8


def embed_bits_in_place(buffer, position_iter, logical_bits, repetition):
    modified_values = 0
    for bit in logical_bits:
        for _ in range(repetition):
            try:
                position = next(position_iter)
            except StopIteration as error:
                raise WatermarkError("载体图像容量不足，无法嵌入当前水印") from error

            original_value = buffer[position]
            updated_value = (original_value & 0xFE) | bit
            if updated_value != original_value:
                modified_values += 1
                buffer[position] = updated_value

    return modified_values


def compute_psnr(original_bytes, modified_bytes):
    if len(original_bytes) != len(modified_bytes):
        return None

    squared_error_sum = 0
    for original, modified in zip(original_bytes, modified_bytes):
        delta = original - modified
        squared_error_sum += delta * delta

    mse = squared_error_sum / len(original_bytes)
    if mse == 0:
        return None

    return 20 * math.log10(255.0 / math.sqrt(mse))


def embed_watermark(input_path, output_path, payload_path, channel_mode, repetition):
    image, rgba_bytes = open_rgba_image(input_path)
    original_bytes = bytes(rgba_bytes)
    pixel_count = len(rgba_bytes) // 4

    if pixel_count < HEADER_BITS:
        raise WatermarkError("图片分辨率过小，无法写入不可见水印头")

    payload_bytes = Path(payload_path).read_bytes()
    capacity_bytes = compute_capacity_bytes(pixel_count, channel_mode, repetition)

    if len(payload_bytes) > capacity_bytes:
        raise WatermarkError(
            f"载体图像容量不足：当前模式最多可写入 {capacity_bytes} 字节，实际需要 {len(payload_bytes)} 字节"
        )

    header_bytes = build_header(channel_mode, repetition, payload_bytes)
    header_modified_values = 0
    for index, bit in enumerate(bytes_to_bits(header_bytes)):
        position = index * 4 + 2
        original_value = rgba_bytes[position]
        updated_value = (original_value & 0xFE) | bit
        if updated_value != original_value:
            header_modified_values += 1
            rgba_bytes[position] = updated_value

    body_modified_values = embed_bits_in_place(
        rgba_bytes,
        iter_body_positions(pixel_count, channel_mode),
        bytes_to_bits(payload_bytes),
        repetition,
    )

    Image.frombytes("RGBA", image.size, bytes(rgba_bytes)).save(output_path, format="PNG")

    psnr = compute_psnr(original_bytes, bytes(rgba_bytes))
    result = {
        "ok": True,
        "width": image.size[0],
        "height": image.size[1],
        "channelMode": channel_mode,
        "repetition": repetition,
        "payloadBytes": len(payload_bytes),
        "capacityBytes": capacity_bytes,
        "utilization": round(len(payload_bytes) / capacity_bytes, 4) if capacity_bytes else 0,
        "modifiedValues": header_modified_values + body_modified_values,
        "psnr": round(psnr, 3) if psnr is not None else None,
        "outputFormat": "png",
    }
    print(json.dumps(result, ensure_ascii=False))


def extract_watermark(input_path):
    _, rgba_bytes = open_rgba_image(input_path)
    pixel_count = len(rgba_bytes) // 4

    if pixel_count < HEADER_BITS:
        raise WatermarkError("图片分辨率过小，无法读取不可见水印头")

    header_bits = []
    for index in range(HEADER_BITS):
        position = index * 4 + 2
        header_bits.append(rgba_bytes[position] & 1)

    header_bytes = bits_to_bytes(header_bits)
    header = parse_header(header_bytes)
    channel_mode = header["channel_mode"]
    repetition = header["repetition"]
    payload_length = header["payload_length"]
    checksum = header["checksum"]
    capacity_bytes = compute_capacity_bytes(pixel_count, channel_mode, repetition)

    if payload_length > capacity_bytes:
        raise WatermarkError("检测到的水印长度超出图像容量，水印可能已损坏")

    logical_bits_needed = payload_length * 8
    body_positions = iter_body_positions(pixel_count, channel_mode)
    extracted_bits = []

    for _ in range(logical_bits_needed):
        votes = []
        for _ in range(repetition):
            try:
                position = next(body_positions)
            except StopIteration as error:
                raise WatermarkError("图片中的水印数据不完整") from error
            votes.append(rgba_bytes[position] & 1)

        extracted_bits.append(1 if sum(votes) >= (repetition // 2 + 1) else 0)

    payload_bytes = bits_to_bytes(extracted_bits)
    actual_checksum = zlib.crc32(payload_bytes) & 0xFFFFFFFF
    if actual_checksum != checksum:
        raise WatermarkError("水印校验失败，图片可能被修改、压缩或裁剪")

    result = {
        "ok": True,
        "channelMode": channel_mode,
        "repetition": repetition,
        "payloadBytes": payload_length,
        "capacityBytes": capacity_bytes,
        "payloadBase64": base64.b64encode(payload_bytes).decode("ascii"),
    }
    print(json.dumps(result, ensure_ascii=False))


def estimate_capacity(input_path, channel_mode, repetition):
    image, rgba_bytes = open_rgba_image(input_path)
    pixel_count = len(rgba_bytes) // 4
    capacity_bytes = compute_capacity_bytes(pixel_count, channel_mode, repetition)
    result = {
        "ok": True,
        "width": image.size[0],
        "height": image.size[1],
        "channelMode": channel_mode,
        "repetition": repetition,
        "capacityBytes": capacity_bytes,
        "headerBytes": HEADER_SIZE,
    }
    print(json.dumps(result, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="Invisible watermark tool")
    subparsers = parser.add_subparsers(dest="command", required=True)

    embed_parser = subparsers.add_parser("embed")
    embed_parser.add_argument("--input", required=True)
    embed_parser.add_argument("--output", required=True)
    embed_parser.add_argument("--payload", required=True)
    embed_parser.add_argument("--channel-mode", required=True, choices=sorted(CHANNEL_CODES.keys()))
    embed_parser.add_argument("--repetition", required=True, type=int, choices=(1, 3, 5))

    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--input", required=True)

    capacity_parser = subparsers.add_parser("capacity")
    capacity_parser.add_argument("--input", required=True)
    capacity_parser.add_argument("--channel-mode", required=True, choices=sorted(CHANNEL_CODES.keys()))
    capacity_parser.add_argument("--repetition", required=True, type=int, choices=(1, 3, 5))

    args = parser.parse_args()

    try:
        if args.command == "embed":
            embed_watermark(
                input_path=args.input,
                output_path=args.output,
                payload_path=args.payload,
                channel_mode=args.channel_mode,
                repetition=args.repetition,
            )
        elif args.command == "extract":
            extract_watermark(args.input)
        else:
            estimate_capacity(
                input_path=args.input,
                channel_mode=args.channel_mode,
                repetition=args.repetition,
            )
    except WatermarkError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(f"Unexpected error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
