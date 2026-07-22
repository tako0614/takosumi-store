output "takos_app" {
  value = {
    name    = "takosumi-store"
    version = "0.1.6"

    compute = {
      web = {
        kind      = "worker"
        readiness = "/readyz"

        # APP_URL is the node's canonical public origin (ServerInfo.baseUrl,
        # OIDC redirect_uri, install-link host de-dup). The routed hostname is
        # only known at apply time, so the Capsule self-consumes its own
        # `launcher` UiSurface publication (routeRef = "root") and the deploy
        # pipeline injects the resolved url as APP_URL.
        #
        # The `identity.oidc` consume auto-provisions a PUBLIC OIDC client
        # ("Sign in with Takosumi Accounts") for this install — auto client_id
        # + redirect_uri derived from the routed hostname — and injects the
        # issuer + client_id. With it wired, publishing works out of the box;
        # without an accounts plane the store still runs read-only.
        consume = [
          {
            publication = "launcher"
            inject = {
              env = {
                url = "APP_URL"
              }
            }
          },
          {
            publication = "identity.oidc"
            inject = {
              env = {
                issuerUrl = "TAKOSUMI_ACCOUNTS_ISSUER_URL"
                clientId  = "TAKOSUMI_ACCOUNTS_CLIENT_ID"
              }
            }
          },
        ]
      }
    }

    resources = {
      database = {
        type       = "sql"
        migrations = "migrations"
        bindings = {
          web = "DB"
        }
      }
      icons = {
        type = "object-store"
        bindings = {
          web = "ICONS"
        }
      }
      kv = {
        type = "key-value"
        bindings = {
          web = "KV"
        }
      }
      session_hash_salt = {
        type     = "secret"
        bind     = "SESSION_HASH_SALT"
        to       = ["web"]
        generate = true
      }
    }

    routes = [
      {
        id     = "root"
        target = "web"
        path   = "/"
      },
    ]

    publish = [
      {
        name      = "launcher"
        publisher = "web"
        type      = "UiSurface"
        outputs = {
          url = {
            kind     = "url"
            routeRef = "root"
          }
        }
        display = {
          title       = "Takosumi Store"
          description = "A self-hostable store for Takos Capsules with an open read API. Browse and install apps; publishers register listings."
          category    = "tools"
          sortOrder   = 60
        }
        spec = {
          launcher = true
        }
      },
    ]

    env = {}
  }
}
