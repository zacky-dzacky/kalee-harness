interface Record { id: string; body: string }

async function upload(r: Record): Promise<void> {
  const res = await fetch("https://example.invalid/records", {
    method: "POST",
    body: JSON.stringify(r),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
}

export async function syncAll(records: Record[]): Promise<{ uploaded: number }> {
  let uploaded = 0;
  for (const r of records) {
    try {
      await upload(r);
      uploaded++;
    } catch {
      // keep going
    }
  }
  return { uploaded };
}

export async function syncAndMarkClean(records: Record[]): Promise<boolean> {
  const { uploaded } = await syncAll(records);
  markLocalStateClean();
  return uploaded === records.length;
}

function markLocalStateClean(): void {
  // drops the local write-ahead log
}
