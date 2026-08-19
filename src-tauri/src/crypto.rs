use std::{
    fs,
    path::{Path, PathBuf},
};

const KEY_BYTES: usize = 32;
const KEY_FILE_MAGIC: &[u8] = b"MOJI-DPAPI-KEY-v1\0";

pub(crate) fn load_or_create_database_key(database_path: &Path) -> Result<Vec<u8>, String> {
    let key_path = key_path(database_path);
    if let Ok(protected) = fs::read(&key_path) {
        if !protected.starts_with(KEY_FILE_MAGIC) {
            return Err("database key file has an invalid format".to_owned());
        }
        let key = unprotect(&protected[KEY_FILE_MAGIC.len()..])?;
        if key.len() != KEY_BYTES {
            return Err("database key has an invalid length".to_owned());
        }
        return Ok(key);
    }

    let mut key = vec![0u8; KEY_BYTES];
    getrandom::fill(&mut key).map_err(|_| "database key could not be generated".to_owned())?;
    let protected = protect(&key)?;
    let mut file = KEY_FILE_MAGIC.to_vec();
    file.extend_from_slice(&protected);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut handle = options
        .open(&key_path)
        .map_err(|error| format!("database key could not be stored: {error}"))?;
    use std::io::Write;
    handle
        .write_all(&file)
        .and_then(|_| handle.sync_all())
        .map_err(|error| format!("database key could not be flushed: {error}"))?;
    Ok(key)
}

fn key_path(database_path: &Path) -> PathBuf {
    let mut value = database_path.as_os_str().to_owned();
    value.push(".key");
    PathBuf::from(value)
}

#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData},
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    let input = blob(data);
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("Windows DPAPI could not protect the database key".to_owned());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(result)
}

#[cfg(not(windows))]
fn protect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("Windows DPAPI is required for the database key".to_owned())
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("Windows DPAPI could not unprotect the database key".to_owned());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(result)
}

#[cfg(not(windows))]
fn unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("Windows DPAPI is required for the database key".to_owned())
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_does_not_store_plaintext_key() {
        let key = b"database-key-for-tests";
        let protected = super::protect(key).expect("DPAPI should be available on Windows");
        assert_ne!(protected, key);
        assert_eq!(super::unprotect(&protected).unwrap(), key);
    }
}
