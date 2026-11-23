FROM golang:1.27.4-alpine3.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /cart .

FROM scratch
COPY --from=build /cart /cart
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/cart"]
