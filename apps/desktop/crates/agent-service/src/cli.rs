//! Command line: the service itself, plus `--console`, `--unenroll` (the MSI uninstall custom
//! action) and the development flags.

use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// No flags: started by the Service Control Manager.
    Service,
    /// Run in the foreground (debugging).
    Console {
        data_dir: Option<PathBuf>,
    },
    /// Tell the server this device is gone and forget the enrollment. Never fails the uninstall.
    Unenroll {
        data_dir: Option<PathBuf>,
    },
    /// Linux/development: serve the protocol on a unix socket, with the machine described by an
    /// optional snapshot JSON file.
    DevPipe {
        path: PathBuf,
        data_dir: Option<PathBuf>,
        snapshot: Option<PathBuf>,
    },
    Version,
}

pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Result<Command, String> {
    let mut it = args.into_iter();
    let (mut console, mut unenroll, mut version) = (false, false, false);
    let (mut dev_pipe, mut data_dir, mut snapshot) = (None, None, None);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--console" => console = true,
            "--unenroll" => unenroll = true,
            "--version" | "-V" => version = true,
            "--dev-pipe" => dev_pipe = Some(PathBuf::from(it.next().ok_or("--dev-pipe needs a socket path")?)),
            "--data-dir" => data_dir = Some(PathBuf::from(it.next().ok_or("--data-dir needs a directory")?)),
            "--snapshot" => snapshot = Some(PathBuf::from(it.next().ok_or("--snapshot needs a JSON file")?)),
            other => return Err(format!("unknown option {other}")),
        }
    }
    if version {
        return Ok(Command::Version);
    }
    if unenroll {
        return Ok(Command::Unenroll { data_dir });
    }
    if let Some(path) = dev_pipe {
        return Ok(Command::DevPipe { path, data_dir, snapshot });
    }
    if snapshot.is_some() {
        return Err("--snapshot only works with --dev-pipe".into());
    }
    if console {
        return Ok(Command::Console { data_dir });
    }
    if data_dir.is_some() {
        return Err("--data-dir needs --console, --unenroll or --dev-pipe".into());
    }
    Ok(Command::Service)
}

pub const USAGE: &str = "neo-agent (Neo Protection service)\n\
    \n\
    Started by the Service Control Manager with no arguments.\n\
    \n\
    Options:\n\
    \x20 --console              run in the foreground (debugging)\n\
    \x20 --unenroll             tell the server this device is gone and forget the enrollment\n\
    \x20 --data-dir <dir>       data directory (with --console, --unenroll, --dev-pipe)\n\
    \x20 --dev-pipe <socket>    Linux development: serve the pipe protocol on a unix socket\n\
    \x20 --snapshot <file>      with --dev-pipe: a Snapshot JSON file describing the machine\n\
    \x20 --version\n";

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<Command, String> {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn modes() {
        assert_eq!(p(&[]), Ok(Command::Service));
        assert_eq!(p(&["--console"]), Ok(Command::Console { data_dir: None }));
        assert_eq!(p(&["--unenroll"]), Ok(Command::Unenroll { data_dir: None }));
        assert_eq!(p(&["--version"]), Ok(Command::Version));
        assert_eq!(
            p(&["--dev-pipe", "/tmp/s", "--data-dir", "/tmp/d", "--snapshot", "/tmp/x.json"]),
            Ok(Command::DevPipe {
                path: "/tmp/s".into(),
                data_dir: Some("/tmp/d".into()),
                snapshot: Some("/tmp/x.json".into())
            })
        );
    }

    #[test]
    fn rejects_nonsense() {
        assert!(p(&["--nope"]).is_err());
        assert!(p(&["--dev-pipe"]).is_err());
        assert!(p(&["--snapshot", "x"]).is_err());
        assert!(p(&["--data-dir", "x"]).is_err());
    }
}
