using System.Text;

namespace Heapscape;

// These are mapped ranges, not malloc blocks or evidence of native pointer ownership.
public static class NativeMap
{
    private const int MaxEntries = 500_000;

    public static (string Source, List<NativeArea> Areas) Read(string path)
    {
        using var stream = File.OpenRead(path);
        using var reader = new BinaryReader(stream, Encoding.UTF8, true);
        At(reader, 0, 32);
        uint magic = reader.ReadUInt32();
        if (magic == 0x504d444d)
            return ReadMinidump(reader);
        if (magic == 0x464c457f)
            return ReadElf(reader);
        return ("unavailable", []);
    }

    private static (string, List<NativeArea>) ReadMinidump(BinaryReader reader)
    {
        At(reader, 8, 8);
        uint count = reader.ReadUInt32();
        uint directory = reader.ReadUInt32();
        CheckCount(count);
        var streams = new Dictionary<uint, (uint Size, uint Rva)>();
        for (uint i = 0; i < count; i++)
        {
            At(reader, checked((long)directory + i * 12L), 12);
            uint kind = reader.ReadUInt32();
            uint size = reader.ReadUInt32();
            uint rva = reader.ReadUInt32();
            At(reader, rva, size);
            streams.TryAdd(kind, (size, rva));
        }
        var result = new List<NativeArea>();
        if (streams.TryGetValue(16, out var info))
        {
            At(reader, info.Rva, 16);
            uint header = reader.ReadUInt32();
            uint entry = reader.ReadUInt32();
            ulong entries = reader.ReadUInt64();
            CheckCount(entries);
            if (header < 16 || entry < 48 || checked(header + entries * entry) > info.Size)
                throw new InvalidDataException("Invalid MemoryInfoList bounds.");
            for (ulong i = 0; i < entries; i++)
            {
                At(reader, checked((long)(info.Rva + header + i * entry)), 48);
                ulong address = reader.ReadUInt64();
                reader.BaseStream.Position += 16;
                ulong size = reader.ReadUInt64();
                uint state = reader.ReadUInt32();
                uint protection = reader.ReadUInt32();
                uint type = reader.ReadUInt32();
                if (state == 0x10000 || size == 0) continue;
                result.Add(Area(address, size, state == 0x1000 ? "committed" : "reserved",
                    type switch { 0x1000000 => "image", 0x40000 => "mapped", 0x20000 => "private", _ => "unknown" },
                    $"0x{protection:x}"));
            }
            return ("Windows MemoryInfoList (virtual mappings; not allocation ownership)", result);
        }
        if (streams.TryGetValue(9, out var memory64))
        {
            At(reader, memory64.Rva, 16);
            ulong entries = reader.ReadUInt64();
            CheckCount(entries);
            if (checked(16 + entries * 16) > memory64.Size)
                throw new InvalidDataException("Invalid Memory64List bounds.");
            for (ulong i = 0; i < entries; i++)
            {
                At(reader, checked((long)(memory64.Rva + 16 + i * 16)), 16);
                result.Add(Area(reader.ReadUInt64(), reader.ReadUInt64(), "captured", "unknown", "unknown"));
            }
            return ("Windows Memory64List (captured ranges only; reservation/protection unavailable)", result);
        }
        if (streams.TryGetValue(5, out var memory))
        {
            At(reader, memory.Rva, 4);
            uint entries = reader.ReadUInt32();
            CheckCount(entries);
            if (4UL + entries * 16UL > memory.Size)
                throw new InvalidDataException("Invalid MemoryList bounds.");
            for (uint i = 0; i < entries; i++)
            {
                At(reader, memory.Rva + 4 + i * 16L, 16);
                result.Add(Area(reader.ReadUInt64(), reader.ReadUInt32(), "captured", "unknown", "unknown"));
            }
            return ("Windows MemoryList (captured ranges only)", result);
        }
        return ("unavailable (no virtual-memory stream)", result);
    }

    private static (string, List<NativeArea>) ReadElf(BinaryReader reader)
    {
        At(reader, 4, 2);
        if (reader.ReadByte() != 2 || reader.ReadByte() != 1)
            return ("unavailable (native map supports little-endian ELF64 only)", []);
        At(reader, 32, 8);
        ulong offset = reader.ReadUInt64();
        At(reader, 54, 4);
        ushort entrySize = reader.ReadUInt16();
        ushort count = reader.ReadUInt16();
        if (entrySize < 56 || count == ushort.MaxValue)
            throw new InvalidDataException("Unsupported ELF program-header layout.");
        var result = new List<NativeArea>();
        for (int i = 0; i < count; i++)
        {
            At(reader, checked((long)offset + i * (long)entrySize), 56);
            uint type = reader.ReadUInt32();
            uint flags = reader.ReadUInt32();
            reader.ReadUInt64();
            ulong address = reader.ReadUInt64();
            reader.ReadUInt64();
            ulong fileSize = reader.ReadUInt64();
            ulong size = reader.ReadUInt64();
            if (type == 1 && size > 0)
                result.Add(Area(address, size, fileSize == 0 ? "not captured" : "mapped (possibly partially captured)",
                    "unknown", $"{((flags & 4) != 0 ? "r" : "-")}{((flags & 2) != 0 ? "w" : "-")}{((flags & 1) != 0 ? "x" : "-")}"));
        }
        return ("ELF PT_LOAD (mapping extents; not malloc blocks)", result);
    }

    private static NativeArea Area(ulong start, ulong size, string state, string kind, string protection) =>
        new(Format.Hex(start), Format.Hex(checked(start + size)), size, state, kind, protection, []);

    private static void At(BinaryReader reader, long position, long bytes)
    {
        if (position < 0 || bytes < 0 || position > reader.BaseStream.Length - bytes)
            throw new InvalidDataException("Dump metadata points outside the file.");
        reader.BaseStream.Position = position;
    }

    private static void CheckCount(ulong count)
    {
        if (count > MaxEntries)
            throw new InvalidDataException($"Native map exceeds the {MaxEntries:N0}-entry safety limit.");
    }
}
