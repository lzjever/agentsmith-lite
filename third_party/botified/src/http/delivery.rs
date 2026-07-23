use super::ApiError;

const MAX_DELIVERY_KEY_BYTES: usize = 200;
const MAX_REQUEST_HASH_BYTES: usize = 256;

#[derive(Debug, Clone)]
pub(super) struct DeliveryInput {
    pub delivery_key: String,
    pub request_hash: String,
}

pub(super) fn delivery_from_body(
    body: &serde_json::Value,
) -> Result<Option<DeliveryInput>, ApiError> {
    let Some(key) = body.get("delivery_key") else {
        if body.get("request_hash").is_some() {
            return Err(ApiError::invalid_request(
                "request_hash requires delivery_key",
            ));
        }
        return Ok(None);
    };
    let key = key
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::invalid_request("delivery_key must be a non-empty string"))?;
    validate_delivery_key(key)?;
    let request_hash = body
        .get("request_hash")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::invalid_request("request_hash must be a non-empty string"))?;
    if request_hash.len() > MAX_REQUEST_HASH_BYTES {
        return Err(ApiError::invalid_request("request_hash is too long"));
    }
    Ok(Some(DeliveryInput {
        delivery_key: key.to_owned(),
        request_hash: request_hash.to_owned(),
    }))
}

pub(super) fn validate_delivery_key(key: &str) -> Result<(), ApiError> {
    if key.is_empty()
        || key.len() > MAX_DELIVERY_KEY_BYTES
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(ApiError::invalid_request(
            "delivery_key must be an ASCII token",
        ));
    }
    Ok(())
}
