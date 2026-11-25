use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use std::sync::Arc;
use tokio_rustls::TlsAcceptor;

pub struct TlsInput {
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
}

pub fn build_tls_acceptor(input: TlsInput) -> Result<TlsAcceptor, String> {
    // Ensure ring crypto provider is installed (idempotent)
    let _ = rustls::crypto::ring::default_provider().install_default();

    // PEM parsing from rustls-pki-types (rustls-pemfile is unmaintained, RUSTSEC-2025-0134).
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(&input.cert_pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse TLS certificate PEM: {e:?}"))?;

    if certs.is_empty() {
        return Err("No valid certificates found in TLS cert PEM".to_string());
    }

    let key: PrivateKeyDer<'static> = match PrivateKeyDer::from_pem_slice(&input.key_pem) {
        Ok(k) => k,
        Err(rustls::pki_types::pem::Error::NoItemsFound) => {
            return Err("No valid private key found in TLS key PEM".to_string())
        }
        Err(e) => return Err(format!("Failed to parse TLS private key PEM: {e:?}")),
    };

    let mut config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("Invalid TLS certificate/key configuration: {e}"))?;

    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(TlsAcceptor::from(Arc::new(config)))
}

#[cfg(test)]
pub(crate) mod test_pems {
    pub(crate) const TEST_CERT_PEM: &[u8] = b"-----BEGIN CERTIFICATE-----\n\
MIIDCTCCAfGgAwIBAgIUE2eMEV3W2rVgoVdHIWfKOYo9PWkwDQYJKoZIhvcNAQEL\n\
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTEyMzExNDkzMloXDTM2MTEy\n\
MDExNDkzMlowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF\n\
AAOCAQ8AMIIBCgKCAQEA16ThiWSM5v5ifDBrQbSumAjY+VxCBjWU8XqXcH9s2Swy\n\
9DMS8DQZiSJmYsES7uysCfgDr6Ts7x60hzUIMolnJYFr4COtErBrwVg1yn+zaKQc\n\
vh8qD8cDCD1991bS7w7Z56CCBXhti4BQFwi1pFh4naK6ncBkJJRJxqFeosis2NjI\n\
IrAE9Yi7rcMFjipYEa6N4oy4LULzgy+HpAS0qI5r805xZ2blyow3jPFZGktTZeuB\n\
0G5Mfy9wjzxf8qVx046ClQcA1PCo1kRwTV94zjj37U/s8NVfpwCZgQESv9vPMp0E\n\
A/zLrOPCT9deW1r9zJqjHA3qkgSQRU1cJYTIGepN1wIDAQABo1MwUTAdBgNVHQ4E\n\
FgQUzbJuIWYHor2d3NUEAyXQNhMqmmYwHwYDVR0jBBgwFoAUzbJuIWYHor2d3NUE\n\
AyXQNhMqmmYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAGCDP\n\
Pa6xav08z8Z0TJxAyuHIHwTo8N7+TGVrfrm9cVtqvNMb4eD1//LAQlAlj6W2NtJc\n\
qzMxY6ARNa6e9DZCgW0FGGVqs55uED36lrVT5/7OMFVKvcFVJ1u0e7HsafwLMDXf\n\
YZmAbos9lNcE+DlaLGWxfsdFaL3kTlmAGjDoD7fUbQx101rmPA0C6Gvmgfi4FsEK\n\
8TQZ0op4B2aJ+erL/HsuC6tOb0Ec/4UDvQESRh3WC7dUZxGwxsc2vYxiiS74DX7M\n\
xtHP+DfCrWH5z9Wwf2GpB1p11yjodLWN/pSt9EDwGpKHY6ifLJ/5tPRUbHiuBFjf\n\
neCBRKE2QW9KIMEB5Q==\n\
-----END CERTIFICATE-----\n";

    pub(crate) const TEST_KEY_PEM: &[u8] = b"-----BEGIN PRIVATE KEY-----\n\
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDXpOGJZIzm/mJ8\n\
MGtBtK6YCNj5XEIGNZTxepdwf2zZLDL0MxLwNBmJImZiwRLu7KwJ+AOvpOzvHrSH\n\
NQgyiWclgWvgI60SsGvBWDXKf7NopBy+HyoPxwMIPX33VtLvDtnnoIIFeG2LgFAX\n\
CLWkWHidorqdwGQklEnGoV6iyKzY2MgisAT1iLutwwWOKlgRro3ijLgtQvODL4ek\n\
BLSojmvzTnFnZuXKjDeM8VkaS1Nl64HQbkx/L3CPPF/ypXHTjoKVBwDU8KjWRHBN\n\
X3jOOPftT+zw1V+nAJmBARK/288ynQQD/Mus48JP115bWv3MmqMcDeqSBJBFTVwl\n\
hMgZ6k3XAgMBAAECggEAT3+E9/I+MbBJXXA6MlRqYzkryC4XVxOsz6M6rioD1kJB\n\
nJ4xlqUWXuR0K2bzVGqi99/beAbMpFDFC+1kksDt6jk+rDhqxy+L4hDjb75JRUPv\n\
JrX1ezCKcSC+Tg9PnvryIT6egGbHt7x7iipXUHmfKboCo0J4iLW0RwpZiZiChEQl\n\
ZHZe7KxBIy7NE2JLPCso31wDk0LQzXwYYP7welfDItQvoF6JPgbMA9JdvPBiP0/v\n\
jGgzlc/9BeRvUc4WjYvVPChHfsCBK9816Pj3vP3u4TCvIPwQ3eE12eWdIw4n/axR\n\
IOFWRJ7+pYmZd/w1jM1ASxU/65a27JDW//XE8ZL23QKBgQD5W3Z4ScPOenAPrNh7\n\
lcp0bjnyd95fJWXruTPGYrUePSdmu/nwXDpyANDZQeVj8urONZ9gsLUrZ9jqXR6E\n\
jEmwdeAB2cd9ajBGPj5teTpB84GXpdCvrqhYBwV1S5+CVVNixOyIQeHIq46C/q5Q\n\
q4qqK5MMsucmiVz9O83sbR8OwwKBgQDdY4E/ShGW2Gbvpdoov2c/pDezYVULoSwy\n\
/cYiR4U7OecUn7HANSDNfjM0piAFsWuzE5vCZIeEQiog4ktu05yLuSbRz5MxK/Wh\n\
JhNaLQPiCYN7I7SvcN2uV4v/m0R0Bz/BtbXfzqiTVAo5magkEoAk2EiyDIsBXMqF\n\
lvq4UCk7XQKBgQCVuVR2P5yBw0S8NMW71yI8LN9AdrcgHD2Jf6fV6/jikkexSRd3\n\
OnmhcFn2yblp/Tb94Ha1QQVXbcByYL1tSysH+I8rrU86P+OCmec0JoFTjln264pV\n\
oqLUUEr3thOt13v9J077NcvTiSdGApQ6PfZB3W4rRtTCb+JU727jElZ+rwKBgQDF\n\
zLObklfoyGwfzbT/FxPunpBNqrbLbzMIVAiEdBYrdm5p1MyBiHZIY2rorUyLCZvK\n\
IcjWg+84Uc1GGCmBWXvSsphmeOlv03DgjB5aQUHo4MsiaCJ1ZYgKzpl8xIMCj799\n\
GRboYcHn7/w6vnil0gm/4aYBvocrrnYbqWtU5foQ2QKBgQCR1KCng8BVG450LuUN\n\
PAsKhHxJSFBDItr5RFi/DG1eAV7fSRA/2u+hJQ6sr8UBv3Zgd62vC28PCcufi/z5\n\
k7vK+E5+bboyfCMhOiFBWtUBjFbhqgZ6fhirC3Nz/V8ooFwatKU6/qxM+wlT+5SB\n\
hl092F/mmeLgYTOCoE/DOyDi1Q==\n\
-----END PRIVATE KEY-----\n";
}

#[cfg(test)]
mod tests {
    use super::test_pems::*;
    use super::*;

    #[test]
    fn rejects_empty_cert_pem() {
        let err = build_tls_acceptor(TlsInput {
            cert_pem: Vec::new(),
            key_pem: TEST_KEY_PEM.to_vec(),
        })
        .err()
        .expect("expected error");
        assert!(err.contains("certificate"), "got: {err}");
    }

    #[test]
    fn rejects_malformed_cert_pem() {
        let err = build_tls_acceptor(TlsInput {
            cert_pem:
                b"-----BEGIN CERTIFICATE-----\nnot-valid-base64!!!\n-----END CERTIFICATE-----\n"
                    .to_vec(),
            key_pem: TEST_KEY_PEM.to_vec(),
        })
        .err()
        .expect("expected error");
        assert!(
            err.contains("certificate") || err.contains("TLS"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_empty_key_pem() {
        let err = build_tls_acceptor(TlsInput {
            cert_pem: TEST_CERT_PEM.to_vec(),
            key_pem: b"not a key".to_vec(),
        })
        .err()
        .expect("expected error");
        assert!(err.contains("private key"), "got: {err}");
    }

    #[test]
    fn accepts_pem_with_surrounding_text_and_rejects_cert_as_key() {
        let mut cert = b"subject=CN = 127.0.0.1\n".to_vec();
        cert.extend_from_slice(TEST_CERT_PEM);
        cert.extend_from_slice(b"trailing notes\n");
        let mut key = b"# comment\n".to_vec();
        key.extend_from_slice(TEST_KEY_PEM);
        assert!(build_tls_acceptor(TlsInput {
            cert_pem: cert,
            key_pem: key,
        })
        .is_ok());
        let err = build_tls_acceptor(TlsInput {
            cert_pem: TEST_CERT_PEM.to_vec(),
            key_pem: TEST_CERT_PEM.to_vec(),
        })
        .err()
        .expect("certificate is not a key");
        assert!(err.contains("private key"), "got: {err}");
    }

    #[test]
    fn accepts_valid_self_signed_pem_pair() {
        let res = build_tls_acceptor(TlsInput {
            cert_pem: TEST_CERT_PEM.to_vec(),
            key_pem: TEST_KEY_PEM.to_vec(),
        });
        assert!(res.is_ok(), "expected Ok, got {:?}", res.err());
    }
}
