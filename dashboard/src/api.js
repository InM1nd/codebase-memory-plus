export class ApiError extends Error {}

export async function getJson(path) {
  let response;
  try {
    response = await fetch(path);
  } catch {
    throw new ApiError("Network request failed. Is the dashboard server running?");
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(`Request failed: ${path}`);
  }

  if (!response.ok) {
    throw new ApiError(data.error ?? `Request failed: ${path}`);
  }

  return data;
}

export async function deleteJson(path) {
  return sendJson(path, "DELETE");
}

export async function putJson(path, body) {
  return sendJson(path, "PUT", body);
}

export async function postJson(path, body) {
  return sendJson(path, "POST", body);
}

async function sendJson(path, method, body) {
  let response;
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

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(`Request failed: ${path}`);
  }

  if (!response.ok) {
    throw new ApiError(data.error ?? `Request failed: ${path}`);
  }

  return data;
}
