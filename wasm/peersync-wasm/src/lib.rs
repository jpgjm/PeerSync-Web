//! Minimal iroh WASM shim for PeerSync (Web).
//!
//! Plays the same role as native/peersync-iroh (C ABI) in the Windows/iOS apps, via wasm-bindgen.
//! The protocol (LIST/GET, etc.) is handled on the TypeScript side (web/src/proto/);
//! this crate is only a thin wrapper around iroh endpoints, connections, and streams.
//!
//! Browser constraints (per the official docs):
//! - Connections always go through a relay (WebSocket). Direct connections and hole punching are not possible.
//! - iroh must be built with default-features = false.
//!
//! Trailing dots in relay URLs (Safari workaround):
//! iroh's default relays and the discovery service (pkarr) data use fully qualified names with a trailing dot,
//! such as `https://use1-1.relay.n0.iroh.link./`. The public relays drop the connection when they receive an SNI with a trailing dot
//! (confirmed with openssl: without the dot a certificate is returned, with the dot the connection is reset). Chrome strips the dot
//! from the SNI before sending, so it works, but Safari (WebKit) sends it with the dot, so all relay HTTPS and WebSocket requests
//! fail and the relay stays disconnected. So the browser version uses dot-free URLs for both its own relay and the peer's relay
//! (they point to the same server, so it can still talk to peers that use the dotted form).

use std::cell::RefCell;
use std::rc::Rc;

use iroh::address_lookup::{
    AddressLookup, AddressLookupBuilder, AddressLookupBuilderError, EndpointData, EndpointInfo,
    Error as LookupError, Item, PkarrPublisher, PkarrResolver,
};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey, TransportAddr};
use n0_future::boxed::BoxStream;
use n0_future::StreamExt;
use wasm_bindgen::prelude::*;

/// ALPN of the PeerSync wire protocol. Must match all three native apps.
const ALPN: &[u8] = b"peersync/0";

fn err_js(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Generates a random 32-byte secret key and returns it as 64 hex characters.
#[wasm_bindgen]
pub fn secret_generate() -> Result<String, JsValue> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(err_js)?;
    // Normalize through SecretKey just in case (same as the native apps).
    let sk = SecretKey::from_bytes(&buf);
    Ok(hex::encode(sk.to_bytes()))
}

fn secret_from_hex(secret_hex: &str) -> Result<SecretKey, JsValue> {
    let bytes = hex::decode(secret_hex.trim()).map_err(|_| err_js("Invalid secret key hex"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| err_js("Secret key must be 32 bytes"))?;
    Ok(SecretKey::from_bytes(&arr))
}

/// Returns the device ID string for a secret key (64 hex characters).
#[wasm_bindgen]
pub fn id_from_secret(secret_hex: &str) -> Result<String, JsValue> {
    Ok(secret_from_hex(secret_hex)?.public().to_string())
}

/// Strips the trailing dot from a relay URL's host name (see the module docs).
fn strip_trailing_dot(url: &RelayUrl) -> RelayUrl {
    let mut u = (**url).clone();
    let stripped = u.domain().and_then(|d| d.strip_suffix('.')).map(str::to_owned);
    if let Some(host) = stripped {
        // Only fails for URLs without a host; in that case keep the URL as is
        let _ = u.set_host(Some(&host));
    }
    RelayUrl::from(u)
}

/// Wrapper that strips trailing dots from peer relay URLs in discovery service results.
#[derive(Debug)]
struct StripRelayDots<T>(T);

impl<T: AddressLookup> AddressLookup for StripRelayDots<T> {
    fn publish(&self, data: &EndpointData) {
        self.0.publish(data);
    }

    fn resolve(&self, endpoint_id: EndpointId) -> Option<BoxStream<Result<Item, LookupError>>> {
        let inner = self.0.resolve(endpoint_id)?;
        Some(Box::pin(inner.map(|r| {
            r.map(|item| {
                let info = item.endpoint_info();
                let addrs = info
                    .addrs()
                    .map(|a| match a {
                        TransportAddr::Relay(url) => TransportAddr::Relay(strip_trailing_dot(url)),
                        other => other.clone(),
                    })
                    .collect::<Vec<_>>();
                let mut data = EndpointData::new(addrs);
                data.set_user_data(info.user_data().cloned());
                Item::new(
                    EndpointInfo::from_parts(info.endpoint_id, data),
                    item.provenance(),
                    item.last_updated(),
                )
            })
        })))
    }
}

#[derive(Debug)]
struct StripRelayDotsBuilder<B>(B);

impl<B: AddressLookupBuilder> AddressLookupBuilder for StripRelayDotsBuilder<B> {
    fn into_address_lookup(
        self,
        endpoint: &Endpoint,
    ) -> Result<impl AddressLookup, AddressLookupBuilderError> {
        Ok(StripRelayDots(self.0.into_address_lookup(endpoint)?))
    }
}

/// Wrapper around an iroh Endpoint.
#[wasm_bindgen]
pub struct WasmNode {
    endpoint: Endpoint,
}

#[wasm_bindgen]
impl WasmNode {
    /// Starts the node. An empty relay_url means the public relays (n0).
    pub async fn start(secret_hex: String, relay_url: String) -> Result<WasmNode, JsValue> {
        let sk = secret_from_hex(&secret_hex)?;
        // Start from the N0 preset (public relays + pkarr discovery) and replace only the relay URL handling
        let mut builder = Endpoint::builder(presets::N0)
            .secret_key(sk)
            .alpns(vec![ALPN.to_vec()])
            .clear_address_lookup()
            .address_lookup(PkarrPublisher::n0_dns())
            .address_lookup(StripRelayDotsBuilder(PkarrResolver::n0_dns()));

        let r = relay_url.trim();
        let urls: Vec<RelayUrl> = if r.is_empty() {
            // Use the same servers as the default public relays (n0), with dot-free URLs
            iroh::defaults::prod::default_relay_map().urls()
        } else {
            vec![r
                .parse()
                .map_err(|e| err_js(format!("Invalid relay URL: {e}")))?]
        };
        builder = builder.relay_mode(RelayMode::Custom(RelayMap::from_iter(
            urls.iter().map(strip_trailing_dot),
        )));

        let endpoint = builder
            .bind()
            .await
            .map_err(|e| err_js(format!("bind: {e}")))?;
        Ok(WasmNode { endpoint })
    }

    /// This device's ID string.
    pub fn id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// URL of the current home relay (empty if not connected). For status display and logging.
    pub fn home_relay(&self) -> String {
        self.endpoint
            .addr()
            .relay_urls()
            .next()
            .map(|u| u.to_string())
            .unwrap_or_default()
    }

    /// Waits until connected to the relay. true = online, false = timed out.
    pub async fn wait_online(&self, timeout_ms: u32) -> bool {
        let online = self.endpoint.online();
        n0_future::time::timeout(
            n0_future::time::Duration::from_millis(timeout_ms as u64),
            online,
        )
        .await
        .is_ok()
    }

    /// Waits for the next incoming connection. Returns the null equivalent (undefined) once the endpoint is closed.
    /// The accept loop runs as a while loop on the JS side.
    pub async fn accept(&self) -> Result<Option<WasmConn>, JsValue> {
        loop {
            match self.endpoint.accept().await {
                Some(incoming) => {
                    // Ignore handshake failures and wait for the next one (same approach as the native apps).
                    let connecting = match incoming.accept() {
                        Ok(c) => c,
                        Err(_) => continue,
                    };
                    match connecting.await {
                        Ok(conn) => return Ok(Some(WasmConn::new(conn))),
                        Err(_) => continue,
                    }
                }
                None => return Ok(None),
            }
        }
    }

    /// Connects to peer_id.
    pub async fn connect(&self, peer_id: String) -> Result<WasmConn, JsValue> {
        let id: EndpointId = peer_id
            .trim()
            .parse()
            .map_err(|e| err_js(format!("Invalid device ID: {e}")))?;
        let addr = EndpointAddr::from(id);
        let conn = self
            .endpoint
            .connect(addr, ALPN)
            .await
            .map_err(|e| err_js(format!("connect: {e}")))?;
        Ok(WasmConn::new(conn))
    }

    /// Stops the node.
    pub async fn shutdown(&self) {
        self.endpoint.close().await;
    }
}

/// Wrapper around a connection. Connection is Clone.
#[wasm_bindgen]
pub struct WasmConn {
    conn: Connection,
}

impl WasmConn {
    fn new(conn: Connection) -> Self {
        Self { conn }
    }
}

#[wasm_bindgen]
impl WasmConn {
    /// The peer's device ID string.
    pub fn remote_id(&self) -> String {
        self.conn.remote_id().to_string()
    }

    /// Opens a new bidirectional stream. Returns a two-element array [WasmSend, WasmRecv].
    pub async fn open_bi(&self) -> Result<js_sys::Array, JsValue> {
        let (send, recv) = self
            .conn
            .open_bi()
            .await
            .map_err(|e| err_js(format!("open_bi: {e}")))?;
        Ok(pair(send, recv))
    }

    /// Accepts the next incoming bidirectional stream. Rejects once the connection is closed.
    pub async fn accept_bi(&self) -> Result<js_sys::Array, JsValue> {
        let (send, recv) = self
            .conn
            .accept_bi()
            .await
            .map_err(|e| err_js(format!("accept_bi: {e}")))?;
        Ok(pair(send, recv))
    }

    /// Whether the connection is closed.
    pub fn is_closed(&self) -> bool {
        self.conn.close_reason().is_some()
    }

    /// Closes the connection (e.g. 403 "not paired").
    pub fn close(&self, code: u32, reason: String) {
        self.conn.close(VarInt::from_u32(code), reason.as_bytes());
    }

    /// Returns the selected path as "<kind>|<rtt_ms>". In the browser this should always be relay.
    pub fn path_summary(&self) -> String {
        if self.conn.close_reason().is_some() {
            return "none|0".into();
        }
        for p in self.conn.paths().iter() {
            if p.is_selected() {
                let kind = if p.is_relay() {
                    "relay"
                } else if p.is_ip() {
                    "direct"
                } else {
                    "other"
                };
                return format!("{kind}|{}", p.rtt().as_millis());
            }
        }
        "none|0".into()
    }
}

fn pair(send: SendStream, recv: RecvStream) -> js_sys::Array {
    let arr = js_sys::Array::new();
    arr.push(&JsValue::from(WasmSend::new(send)));
    arr.push(&JsValue::from(WasmRecv::new(recv)));
    arr
}

/// Wrapper around a send stream.
/// Wrapped in Rc<RefCell> because wasm-bindgen async methods cannot borrow self across an await.
#[wasm_bindgen]
pub struct WasmSend {
    inner: Rc<RefCell<SendStream>>,
}

impl WasmSend {
    fn new(send: SendStream) -> Self {
        Self {
            inner: Rc::new(RefCell::new(send)),
        }
    }
}

#[wasm_bindgen]
impl WasmSend {
    /// Writes all bytes.
    pub async fn write(&self, buf: Vec<u8>) -> Result<(), JsValue> {
        let inner = self.inner.clone();
        let mut s = inner.borrow_mut();
        s.write_all(&buf)
            .await
            .map_err(|e| err_js(format!("write_all: {e}")))
    }

    /// Finishes the stream normally.
    pub fn finish(&self) -> Result<(), JsValue> {
        self.inner
            .borrow_mut()
            .finish()
            .map_err(|e| err_js(format!("finish: {e}")))
    }

    /// Resets the stream (ends the peer's read with an error).
    pub fn reset(&self, code: u32) -> Result<(), JsValue> {
        self.inner
            .borrow_mut()
            .reset(VarInt::from_u32(code))
            .map_err(|e| err_js(format!("reset: {e}")))
    }
}

/// Wrapper around a receive stream.
#[wasm_bindgen]
pub struct WasmRecv {
    inner: Rc<RefCell<RecvStream>>,
}

impl WasmRecv {
    fn new(recv: RecvStream) -> Self {
        Self {
            inner: Rc::new(RefCell::new(recv)),
        }
    }
}

#[wasm_bindgen]
impl WasmRecv {
    /// Reads exactly len bytes. Rejects on EOF or error.
    pub async fn read_exact(&self, len: u32) -> Result<Vec<u8>, JsValue> {
        let inner = self.inner.clone();
        let mut r = inner.borrow_mut();
        let mut buf = vec![0u8; len as usize];
        r.read_exact(&mut buf)
            .await
            .map_err(|e| err_js(format!("read_exact: {e}")))?;
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::address_lookup::MemoryLookup;

    /// Minimal executor for tests (MemoryLookup resolution completes without waiting).
    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn noop(_: *const ()) {}
        fn clone(p: *const ()) -> RawWaker {
            RawWaker::new(p, &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
        let mut cx = Context::from_waker(&waker);
        let mut f = std::pin::pin!(f);
        loop {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    #[test]
    fn strips_trailing_dot_only_from_host() {
        let u: RelayUrl = "https://use1-1.relay.n0.iroh.link./".parse().unwrap();
        assert_eq!(strip_trailing_dot(&u).to_string(), "https://use1-1.relay.n0.iroh.link/");
        let plain: RelayUrl = "https://relay.example.com/".parse().unwrap();
        assert_eq!(strip_trailing_dot(&plain), plain);
        let local: RelayUrl = "http://localhost:3340".parse().unwrap();
        assert_eq!(strip_trailing_dot(&local).to_string(), "http://localhost:3340/");
    }

    #[test]
    fn default_relays_have_dots_and_we_strip_them() {
        let urls: Vec<RelayUrl> = iroh::defaults::prod::default_relay_map().urls();
        assert_eq!(urls.len(), 4);
        assert!(urls.iter().all(|u| u.domain().unwrap().ends_with('.')), "{urls:?}");
        assert!(urls.iter().map(strip_trailing_dot).all(|u| !u.domain().unwrap().ends_with('.')));
    }

    #[test]
    fn lookup_results_are_stripped() {
        let id = SecretKey::from_bytes(&[7u8; 32]).public();
        let mem = MemoryLookup::new();
        let relay: RelayUrl = "https://aps1-1.relay.n0.iroh.link./".parse().unwrap();
        mem.add_endpoint_info(EndpointInfo::new(id).with_relay_url(relay));
        let lookup = StripRelayDots(mem);
        let mut stream = lookup.resolve(id).expect("stream");
        let item = block_on(stream.next()).expect("item").expect("ok");
        let urls: Vec<String> = item.relay_urls().map(|u| u.to_string()).collect();
        assert_eq!(urls, vec!["https://aps1-1.relay.n0.iroh.link/".to_string()]);
    }
}
