#include "gtest/gtest.h"

#include "nsCOMPtr.h"
#include "mozilla/Maybe.h"
#include "mozilla/PreloadHashKey.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "nsNetUtil.h"
#include "nsIChannel.h"
#include "nsIStreamListener.h"
#include "nsThreadUtils.h"
#include "nsStringStream.h"
#include "nsIPrivateBrowsingChannel.h"
#include "nsIInterfaceRequestor.h"
#include "nsContentUtils.h"
#include "mozilla/net/NeckoChannelParams.h"
#include "nsHttpConnectionInfo.h"

using namespace mozilla;

class FakeListener : public nsIStreamListener, public nsIInterfaceRequestor {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIREQUESTOBSERVER
  NS_DECL_NSISTREAMLISTENER
  NS_DECL_NSIINTERFACEREQUESTOR

  enum { Never, OnStart, OnData, OnStop } mCancelIn = Never;

  nsresult mOnStartResult = NS_OK;
  nsresult mOnDataResult = NS_OK;
  nsresult mOnStopResult = NS_OK;

  bool mOnStart = false;
  nsCString mOnData;
  Maybe<nsresult> mOnStop;

 private:
  virtual ~FakeListener() = default;
};

NS_IMPL_ISUPPORTS(FakeListener, nsIStreamListener, nsIRequestObserver,
                  nsIInterfaceRequestor)

NS_IMETHODIMP
FakeListener::GetInterface(const nsIID& aIID, void** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = nullptr;
  return NS_NOINTERFACE;
}

NS_IMETHODIMP FakeListener::OnStartRequest(nsIRequest* request) {
  EXPECT_FALSE(mOnStart);
  mOnStart = true;

  if (mCancelIn == OnStart) {
    request->Cancel(NS_ERROR_ABORT);
  }

  return mOnStartResult;
}

NS_IMETHODIMP FakeListener::OnDataAvailable(nsIRequest* request,
                                            nsIInputStream* input,
                                            uint64_t offset, uint32_t count) {
  nsAutoCString data;
  data.SetLength(count);

  uint32_t read;
  input->Read(data.BeginWriting(), count, &read);
  mOnData += data;

  if (mCancelIn == OnData) {
    request->Cancel(NS_ERROR_ABORT);
  }

  return mOnDataResult;
}

NS_IMETHODIMP FakeListener::OnStopRequest(nsIRequest* request,
                                          nsresult status) {
  EXPECT_FALSE(mOnStop);
  mOnStop.emplace(status);

  if (mCancelIn == OnStop) {
    request->Cancel(NS_ERROR_ABORT);
  }

  return mOnStopResult;
}

// Test that nsHttpChannel::AsyncOpen properly picks up changes to
// loadInfo.mPrivateBrowsingId that occur after the channel was created.
TEST(TestHttpChannel, PBAsyncOpen)
{
  nsCOMPtr<nsIURI> uri;
  NS_NewURI(getter_AddRefs(uri), "http://localhost/"_ns);

  nsCOMPtr<nsIChannel> channel;
  nsresult rv = NS_NewChannel(
      getter_AddRefs(channel), uri, nsContentUtils::GetSystemPrincipal(),
      nsILoadInfo::SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      nsIContentPolicy::TYPE_OTHER);
  ASSERT_EQ(rv, NS_OK);

  RefPtr<FakeListener> listener = new FakeListener();
  rv = channel->SetNotificationCallbacks(listener);
  ASSERT_EQ(rv, NS_OK);

  nsCOMPtr<nsIPrivateBrowsingChannel> pbchannel = do_QueryInterface(channel);
  ASSERT_TRUE(pbchannel);

  bool isPrivate = false;
  rv = pbchannel->GetIsChannelPrivate(&isPrivate);
  ASSERT_EQ(rv, NS_OK);
  ASSERT_EQ(isPrivate, false);

  nsCOMPtr<nsILoadInfo> loadInfo = channel->LoadInfo();
  OriginAttributes attrs;
  attrs.mPrivateBrowsingId = 1;
  rv = loadInfo->SetOriginAttributes(attrs);
  ASSERT_EQ(rv, NS_OK);

  rv = pbchannel->GetIsChannelPrivate(&isPrivate);
  ASSERT_EQ(rv, NS_OK);
  ASSERT_EQ(isPrivate, false);

  rv = channel->AsyncOpen(listener);
  ASSERT_EQ(rv, NS_OK);

  rv = pbchannel->GetIsChannelPrivate(&isPrivate);
  ASSERT_EQ(rv, NS_OK);
  ASSERT_EQ(isPrivate, true);

  MOZ_ALWAYS_TRUE(mozilla::SpinEventLoopUntil(
      "TEST(TestHttpChannel, PBAsyncOpen)"_ns,
      [&]() -> bool { return listener->mOnStop.isSome(); }));
}

TEST(TestHttpConnectionInfo, ExplicitAddressRouteRoundTrip)
{
  OriginAttributes attributes;
  RefPtr<net::nsHttpConnectionInfo> original = new net::nsHttpConnectionInfo(
      "origin.example"_ns, 443, ""_ns, ""_ns, nullptr, attributes, true);
  nsTArray<nsCString> addresses;
  addresses.AppendElement("2606:4700:4700::1111"_ns);
  addresses.AppendElement("1.1.1.1"_ns);
  RefPtr<net::nsHttpConnectionInfo> routed =
      original->CloneAndRouteToIPAddresses(addresses, 443);

  net::HttpConnectionInfoCloneArgs args;
  net::nsHttpConnectionInfo::SerializeHttpConnectionInfo(routed, args);
  RefPtr<net::nsHttpConnectionInfo> roundTrip =
      net::nsHttpConnectionInfo::DeserializeHttpConnectionInfoCloneArgs(args);

  ASSERT_TRUE(roundTrip);
  EXPECT_TRUE(roundTrip->HashKey().Equals(routed->HashKey()));
  EXPECT_TRUE(roundTrip->GetOrigin().Equals("origin.example"_ns));
  EXPECT_TRUE(roundTrip->EndToEndSSL());
  EXPECT_TRUE(roundTrip->FirstHopSSL());
  EXPECT_TRUE(roundTrip->GetRoutedHost().Equals(addresses[0]));
  ASSERT_EQ(roundTrip->GetRoutedIPAddresses().Length(), addresses.Length());
  EXPECT_TRUE(roundTrip->GetRoutedIPAddresses()[0].Equals(addresses[0]));
  EXPECT_TRUE(roundTrip->GetRoutedIPAddresses()[1].Equals(addresses[1]));

  nsTArray<nsCString> differentAddresses(addresses.Clone());
  differentAddresses[1] = "8.8.8.8"_ns;
  RefPtr<net::nsHttpConnectionInfo> differentRoute =
      original->CloneAndRouteToIPAddresses(differentAddresses, 443);
  EXPECT_FALSE(differentRoute->HashKey().Equals(routed->HashKey()));
}
