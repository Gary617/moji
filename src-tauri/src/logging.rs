use tracing_subscriber::util::SubscriberInitExt;

pub fn init() {
    let _ = tracing_subscriber::fmt()
        .compact()
        .with_ansi(cfg!(debug_assertions))
        .with_target(false)
        .finish()
        .try_init();
}
