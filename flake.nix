{
  description = "brand — digital business card at bruno.bronosky.com";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # The site's domain comes from config.json, the single source of
        # truth, so the QR can never drift from where Pages serves the site.
        domainFromConfig = ''
          domain="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("config.json","utf8")).domain)')"
        '';

        # Regenerate qr.svg, then prove it decodes to the URL we meant.
        qr = pkgs.writeShellApplication {
          name = "qr";
          runtimeInputs = with pkgs; [ qrencode zbar coreutils nodejs_22 ];
          text = ''
            if [ -n "''${1:-}" ]; then
              url="$1"
            elif [ -f config.json ]; then
              ${domainFromConfig}
              url="https://$domain/"
            else
              echo "no config.json and no url argument" >&2
              echo "  cp config.example.json config.json" >&2
              exit 1
            fi

            qrencode -t SVG -o qr.svg -m 2 -s 8 --level=M "$url"

            tmp="$(mktemp -d)"
            trap 'rm -rf "$tmp"' EXIT
            qrencode -t PNG -o "$tmp/qr.png" -m 2 -s 8 --level=M "$url"
            got="$(zbarimg --quiet --raw "$tmp/qr.png" | tr -d '\n')"

            if [ "$got" != "$url" ]; then
              echo "QR MISMATCH: encoded '$got' but wanted '$url'" >&2
              exit 1
            fi
            echo "qr.svg OK -> $got"
          '';
        };

        # Verify the COMMITTED qr.svg really points at the configured domain.
        # If the domain changes and nobody regenerates the QR, every code
        # already shown or printed silently 404s — invisible until someone scans.
        qr-check = pkgs.writeShellApplication {
          name = "qr-check";
          runtimeInputs = with pkgs; [ zbar imagemagick coreutils nodejs_22 ];
          text = ''
            ${domainFromConfig}
            want="https://$domain/"
            tmp="$(mktemp -d)"
            trap 'rm -rf "$tmp"' EXIT
            magick -background white qr.svg "$tmp/qr.png"
            got="$(zbarimg --quiet --raw "$tmp/qr.png" | tr -d '\n')"
            if [ "$got" != "$want" ]; then
              echo "FAIL: qr.svg encodes '$got' but config.json says '$want'" >&2
              echo "      run: qr" >&2
              exit 1
            fi
            echo "PASS: qr.svg -> $got (matches config.json)"
          '';
        };

        serve = pkgs.writeShellApplication {
          name = "serve";
          runtimeInputs = [ pkgs.python3 ];
          text = ''
            port="''${1:-8765}"
            bind="''${BIND:-127.0.0.1}"
            [ -d dist ] || { echo "no dist/ yet — run: ./brand-bot build" >&2; exit 1; }
            echo "http://$bind:$port"
            python3 -m http.server "$port" --bind "$bind" --directory dist
          '';
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            qrencode          # generate the QR
            zbar              # decode it back, to verify
            python3           # local preview server
            nodejs_22         # build.mjs
            git
            gh                # gh repo / gh api, for Pages setup
            dnsutils          # dig, for DNS checks while setting up Pages
            curl
            qr
            qr-check
            serve
          ];

          shellHook = ''
            echo "brand devshell"
            echo "  serve [port]   local preview (default 8765)"
            echo "  qr [url]       regenerate qr.svg from CNAME"
            echo "  qr-check       assert committed qr.svg matches CNAME"
          '';
        };
      });
}
