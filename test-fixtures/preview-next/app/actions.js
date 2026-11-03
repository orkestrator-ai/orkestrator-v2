"use server";

export async function echo(_previous, formData) {
  return { message: `echo: ${String(formData.get("text") ?? "")}` };
}
