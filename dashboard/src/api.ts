export class ApiError extends Error {}

export async function getJson<T = unknown>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path);
  } catch {
    throw new ApiError("Network request failed. Is the dashboard server running?");
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(`Request failed: ${path}`);
  }

  if (!response.ok) {
    throw new ApiError(data?.error ?? `Request failed: ${path}`);
  }

  return data as T;
}

export async function deleteJson<T = unknown>(path: string): Promise<T> {
  return sendJson<T>(path, "DELETE");
}

export async function putJson<T = unknown>(path: string, body?: unknown): Promise<T> {
  return sendJson<T>(path, "PUT", body);
}

export async function postJson<T = unknown>(path: string, body?: unknown): Promise<T> {
  return sendJson<T>(path, "POST", body);
}

async function sendJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {})
    });
  } catch {
    throw new ApiError("Network request failed. Is the dashboard server running?");
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(`Request failed: ${path}`);
  }

  if (!response.ok) {
    throw new ApiError(data?.error ?? `Request failed: ${path}`);
  }

  return data as T;
}
